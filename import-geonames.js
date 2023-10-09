const https = require('https');
const fs = require('fs');
const StreamZip = require('node-stream-zip');
const readline = require('readline');
//const simplify = require('@mapbox/geosimplify-js');

const { GeonamesDb } = require('./storage');
const db = new GeonamesDb();

function downloadFile(url, fname) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(`dumps/${fname}`);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`${fname} downloaded`);
        resolve();
      });
    });
  });
}

(async () => {
  await db.createTables();

  if (!fs.existsSync('dumps')) {
    fs.mkdirSync('dumps');
  }

  const source = 'cities15000';
  await downloadFile(`https://download.geonames.org/export/dump/countryInfo.txt`, `countryInfo.txt`);
  await downloadFile(`https://download.geonames.org/export/dump/admin1CodesASCII.txt`, `admin1CodesASCII.txt`);
  await downloadFile(`https://download.geonames.org/export/dump/${source}.zip`, `${source}.zip`);
  await downloadFile(`https://download.geonames.org/export/dump/alternateNamesV2.zip`, `alternateNamesV2.zip`);

  let zip, stm, rl;

  rl = readline.createInterface({
    input: fs.createReadStream(`dumps/countryInfo.txt`),
    crlfDelay: Infinity
  });
  let countryIds = {};
  let insertCountryNames = db.bulkInsert('countries_names', ['code', 'language_code', 'name']);
  for await (const line of rl) {
    if (line[0] == '' || line[0] == '#') continue;
    const [iso2, iso3, isoNum, fips, countryName,	capital, area, population, continent, tld, currencyCode, currencyName, phone, postalCodeFmt, postalCodeRegex, langs, geonameId] = line.split('\t');
    countryIds[geonameId] = iso2.toLowerCase();
    // await insertCountryNames(iso2.toLowerCase(), '', countryName);
  }
  await insertCountryNames();
  
  rl = readline.createInterface({
    input: fs.createReadStream(`dumps/admin1CodesASCII.txt`),
    crlfDelay: Infinity
  });
  const regionIds = {};
  const regionCodes = {};
  let insertRegionsNames = db.bulkInsert('regions_names', ['id', 'language_code', 'name']);
  for await (const line of rl) {
    const [code, name, nameAscii, geonameId] = line.split('\t');
    regionCodes[code] = geonameId;
    regionIds[geonameId] = code;
    // await insertRegionsNames(geonameId, '', name);
  }
  await insertRegionsNames();

  zip = new StreamZip.async({ file: `dumps/${source}.zip` });
  stm = await zip.stream(source + '.txt');
  stm.on('end', () => zip.close());
  rl = readline.createInterface({
    input: stm,
    crlfDelay: Infinity
  });

  const citiesIds = {};
  const binfile = fs.createWriteStream('static/cities-coords.bin');
  let idx = 0;

  const insertCities = db.bulkInsert('cities', ['id', 'country_code', 'region_id', 'idx', 'fcode', 'population', 'latitude', 'longitude']);
  let insertCitiesNames = db.bulkInsert('cities_names', ['id', 'language_code', 'name', 'norm_name']);
  for await (const line of rl) {
    // See https://download.geonames.org/export/dump/ for details
    const [
      geonameId, name, asciiName, alternateNames,
      latitude, longitude, featureClass, featureCode,
      countryCode, cc2, admin1, admin2,
      admin3, admin4, population, elevation,
      dem, timezone, modificationDate
    ] = line.split('\t');
    if (['PPLX', 'PPLW', 'PPLQ'].includes(featureCode)) {
      continue;
    }

    // Fixed-point encoding: remap latitude from [-90..90] to [0..65535], and longitude from [-180..180] to [0..65535]
    const latWord = Math.round((parseFloat(latitude) + 90.0) * 65535 / 180);
    const lngWord = Math.round((parseFloat(longitude) + 180.0) * 65535 / 360);
    citiesIds[geonameId] = countryCode + '.' + admin1;
    const maxDist = Math.min(255, 18 * Math.pow(parseInt(population) / 1000, 0.26));

    binfile.write(new Uint8Array([latWord & 0xFF, latWord >> 8, lngWord & 0xFF, lngWord >> 8, maxDist]));

    await insertCities(geonameId, countryCode.toLowerCase(), regionCodes[countryCode + '.' + admin1], idx, featureCode, population, latitude, longitude);
    // await insertCitiesNames(geonameId, '', name, db.normName(name)); // Insert default name
    idx++;
  }
  await insertCities();
  await insertCitiesNames();
  binfile.close();
  console.log('Done, wrote static/cities-coords.bin');

  zip = new StreamZip.async({ file: `dumps/alternateNamesV2.zip` });
  stm = await zip.stream('alternateNamesV2.txt');
  rl = readline.createInterface({
    input: stm,
    crlfDelay: Infinity
  });

  const preferred = new Map();
  let count = 0;
  for await (const line of rl) {
    let [alternateNameId, geonameId, languageCode, alternateName, isPreferredName, isShortName, isColloquial, isHistoric, fromPeriod, toPeriod] = line.split('\t');
    const id = geonameId + languageCode;
    if (isColloquial || isHistoric || (languageCode.length > 3)) {
      continue;
    }
    if (!preferred.has(id) || isPreferredName) { // Preferred names should override any other
      preferred.set(id, parseInt(alternateNameId)); // Save only ids, because otherwise it takes too much memory
    }
    count++;
    if (count % 1000000 == 0) {
      console.log(count);
    }
  }

  stm = await zip.stream('alternateNamesV2.txt');
  stm.on('end', () => zip.close());
  rl = readline.createInterface({
    input: stm,
    crlfDelay: Infinity
  });
  
  insertCitiesNames = db.bulkInsert('cities_names', ['id', 'language_code', 'name', 'norm_name'], { ignore: true });
  insertRegionsNames = db.bulkInsert('regions_names', ['id', 'language_code', 'name'], { ignore: true });
  insertCountryNames = db.bulkInsert('countries_names', ['code', 'language_code', 'name'], { ignore: true });
  for await (const line of rl) {
    let [alternateNameId, geonameId, languageCode, alternateName, isPreferredName, isShortName, isColloquial, isHistoric, fromPeriod, toPeriod] = line.split('\t');
    const id = geonameId + languageCode;
    if (parseInt(alternateNameId) != preferred.get(id)) {
      continue;
    }
    if (geonameId in citiesIds) {
      await insertCitiesNames(geonameId, languageCode, alternateName, db.normName(alternateName));
    } else
    if (geonameId in regionIds) {
      if (alternateName.indexOf('Область') > -1) {
        alternateName = alternateName.split('Область').join('область'); // fix weird capitalization for some regions
      }
      await insertRegionsNames(geonameId, languageCode, alternateName);
    } else
    if (geonameId in countryIds) {
      await insertCountryNames(countryIds[geonameId], languageCode, alternateName);
    }
  }
  await insertCitiesNames();
  await insertRegionsNames();
  await insertCountryNames();
})();