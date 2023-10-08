const path = require('path'); 
require('dotenv').config({ path: path.join(__dirname, '.env') });

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./db.sqlite3');
const { GeonamesDb, BotDb } = require('./storage');

const geoDb = new GeonamesDb();

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT, username TEXT, language_code TEXT, latitude REAL, longitude REAL, country_code TEXT, region_id INT, city_id INT, is_pingable INT NOT NULL DEFAULT 0, last_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS maps (id INTEGER PRIMARY KEY, code TEXT NOT NULL, type TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS maps_users (map_id INT NOT NULL, user_id INT NOT NULL, PRIMARY KEY (map_id, user_id));
  CREATE TABLE IF NOT EXISTS followers (user_id INT NOT NULL, target_id INT NOT NULL, is_blocked INT NOT NULL, PRIMARY KEY (user_id, target_id));

  CREATE UNIQUE INDEX IF NOT EXISTS maps_code ON maps (code);
`);

for (let fnName of ['run', 'all', 'get', 'exec']) {
  db[fnName + 'Async'] = (sql, ...params) => {
    return new Promise((resolve, reject) => {
      db[fnName](sql, ...params, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }
}

function deg2rad(deg) {
  return deg * (Math.PI/180)
}

function getDistance(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = deg2rad(lat2-lat1);
  var dLon = deg2rad(lon2-lon1); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function alignToDistrict(lon, lat, step = 1) { // align to grid (step is in km)
  const latDeg = 111.111;  // 1 latitudal degree in km
  const a = 6378137.0;  // equatorial radius in meters
  const b = 6356752.3;  // polar radius in meters

  lat = (Math.floor(lat * latDeg / step) + 0.5) * step / latDeg;
  lat = Math.round(lat * 1e5) / 1e5;
  const latRad = lat * Math.PI / 180;

  const cos = Math.cos(latRad);
  const sin = Math.sin(latRad);
  const t1 = a * a * cos;
  const t2 = b * b * sin;
  const t3 = a * cos;
  const t4 = b * sin;
  const lonDeg = 2 * Math.PI * Math.sqrt((t1*t1 + t2*t2) / (t3*t3 + t4*t4)) / 360 / 1000;

  console.log(lat, lonDeg);
  lon = (Math.floor(lon * lonDeg / step) + 0.5) * step / lonDeg;
  lon = Math.round(lon * 1e5) / 1e5;
  return [lon, lat];
}

function validateInitData(initData) {
  const data = {};
  const raw = {};
  let hash;
  for (let line of initData.split('&')) {
    const pair = line.split('=');
    if (pair.length == 2) {
      const key = decodeURIComponent(pair[0]);
      const value = decodeURIComponent(pair[1]);
      if (key == 'hash') {
        hash = value;
      } else {
        raw[key] = value;
        data[key] = (key == 'user') ? JSON.parse(value) : value;
      }
    }
  }
  const keys = Object.keys(data);
  keys.sort();

  const list = [];
  for (let key of keys) {
    list.push(`${key}=${raw[key]}`);
  }
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_TOKEN).digest();
  const correctHash = crypto.createHmac('sha256', secretKey).update(list.join('\n')).digest('hex');
  
  if (correctHash != hash) {
    return null;
  }
  return data;
}

bot.on('my_chat_member', async (msg) => {
  // Update isPingable status when user starts or stops this bot
  if (msg.chat.type != 'private') {
    return;
  }
  const isPingable = msg.new_chat_member.status == 'member';
  const me = msg.from;
  await db.runAsync('INSERT INTO users (id, first_name, last_name, username, language_code, is_pingable) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, username=excluded.username, language_code=excluded.language_code, is_pingable=excluded.is_pingable', me.id, me.first_name, me.last_name, me.username, me.language_code, isPingable);
});
bot.on('message', async (msg) => {
  if (msg.write_access_allowed) { // If user allowed writing when opened app, it won't cause '/start'.
    processStart(msg);
  }
});
bot.on('callback_query', async (q) => {
  const user = q.from;
  const [kind, mapId, targetId, action] = q.data.split(':');
  if (kind == 'follow') {
    const target = await db.getAsync('SELECT * FROM users WHERE id = ?', targetId);
    if (parseInt(action)) {
      await followUser(user, targetId, parseInt(mapId), true);
    } else {
      await db.runAsync('DELETE FROM followers WHERE user_id = ? AND target_id = ?', user.id, targetId);
    }
    
    bot.answerCallbackQuery(q.id, {
      text: parseInt(action) ? `You followed ${target.first_name} back` : `You unfollowed ${target.first_name}`,
    });
    bot.editMessageReplyMarkup(await getReplyMarkup(user.id, mapId, targetId), {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
    });
  } else
  if (kind == 'block') {
    const target = await db.getAsync('SELECT * FROM users WHERE id = ?', targetId);
    if (parseInt(action)) {
      await db.runAsync('UPDATE followers SET is_blocked = 1 WHERE user_id = ? AND target_id = ?', targetId, user.id);
    } else {
      await db.runAsync('DELETE FROM followers WHERE user_id = ? AND target_id = ?', targetId, user.id);
    }
    bot.answerCallbackQuery(q.id, {
      text: parseInt(action) ? `You blocked ${target.first_name} from following you` : `You unblocked ${target.first_name}`,
    });
    bot.editMessageReplyMarkup(await getReplyMarkup(user.id, mapId, targetId), {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
    });
  }
});

async function processStart(msg) {
  if (msg.chat.type != 'private') {
    return;
  }

  const chatId = msg.chat.id;
  const me = msg.from;
  await db.runAsync('INSERT INTO users (id, first_name, last_name, username, language_code, is_pingable) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, username=excluded.username, language_code=excluded.language_code, is_pingable=excluded.is_pingable', me.id, me.first_name, me.last_name, me.username, me.language_code);
  
  bot.sendMessage(chatId, `Welcome! To start sharing your location with friends, send the following link to any chat or channel:\n\n<code>https://t.me/${process.env.TELEGRAM_USERNAME}/map</code>\n\nFor each chat it will display a unique map. Follow people on those maps to add them to your personal map (available here, in bottom-left corner).`, {
    parse_mode: 'HTML',
  });
}

bot.onText(/^\/start$/, processStart);

bot.onText(/^\/hide$/, async (msg) => {
  if (msg.chat.type != 'private') {
    return;
  }

  const chatId = msg.chat.id;
  await db.runAsync('UPDATE users SET latitude = NULL, longitude = NULL, country_code = NULL, city_id = NULL WHERE id = ?', msg.from.id);
  await db.runAsync('DELETE FROM maps_users WHERE user_id = ?', msg.from.id);
  bot.sendMessage(chatId, 'Your position is now hidden from <b>all maps</b>.', {
    parse_mode: 'HTML',
  });
});

app.use(express.json());

app.post('/users', async (req, res) => {
  const initData = validateInitData(req.body.initData);
  if (!initData) {
    res.json({ error: 'Invalid initData' });
    return;
  }

  const me = initData.user;
  await db.runAsync('INSERT INTO users (id, first_name, last_name, username, language_code) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, username=excluded.username, language_code=excluded.language_code', me.id, me.first_name, me.last_name, me.username, me.language_code);

  const followersMap = {};
  let rows;

  if (req.body.type == 'menu') {
    const followers = await db.allAsync(`SELECT * FROM followers WHERE user_id = ? AND NOT is_blocked`, me.id);
    const userIds = [me.id];
    for (let row of followers) {
      followersMap[row.target_id] = true;
      userIds.push(row.target_id);
    }

    rows = await db.allAsync(`SELECT * FROM users WHERE id IN (${userIds.join(',')})`);
  } else {
    if (!initData.chat_instance) {
      res.json({});
      return;
    }

    await db.runAsync('INSERT INTO maps (code, type) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET type=excluded.type', initData.chat_instance, initData.chat_type);

    const map = await db.getAsync('SELECT * FROM maps WHERE code = ?', initData.chat_instance);
    rows = await db.allAsync('SELECT * FROM maps_users LEFT JOIN users ON maps_users.user_id = users.id WHERE map_id = ? AND longitude IS NOT NULL AND latitude IS NOT NULL', map.id);
    
    const userIds = [];
    for (let row of rows) {
      userIds.push(row.id);
    }

    if (userIds.length) {
      const followers = await db.allAsync(`SELECT * FROM followers WHERE user_id = ? AND target_id IN (${userIds.join(',')}) AND NOT is_blocked`, me.id);
      for (let row of followers) {
        followersMap[row.target_id] = true;
      }
    }
  }

  const cityIds = {};
  const regionIds = {};
  const countryCodes = {};
  for (let user of rows) {
    user.city_id && (cityIds[user.city_id] = true);
    user.region_id && (regionIds[user.region_id] = true);
    user.country_code && (countryCodes[user.country_code] = true);
  }

  const [cities, regions, countries] = await Promise.all([
    geoDb.citiesNamesByIds(Object.keys(cityIds), me.language_code),
    geoDb.regionsNamesByIds(Object.keys(regionIds), me.language_code),
    geoDb.countriesNamesByIds(Object.keys(countryCodes), me.language_code)
  ]);

  const users = {};
  for (let row of rows) {
    const user =  {
      first_name: row.first_name,
      country_code: row.country_code,
      is_followed: !!followersMap[row.id],
      is_pingable: !!row.is_pingable,
    }
    if (row.last_name) {
      user.last_name = row.last_name;
    }
    if (row.username) {
      user.username = row.username;
    }
    if (row.city_id) {
      user.city_id = row.city_id;
    }
    if (row.longitude !== null && row.latitude !== null) {
      user.longitude = row.longitude;
      user.latitude = row.latitude;
    }
    users[row.id] = user;
  }
  res.json({ users, cities, regions, countries });
});

async function getReplyMarkup(userId, mapId, targetId) {
  const follower = await db.getAsync('SELECT * FROM followers WHERE user_id = ? AND target_id = ?', userId, targetId);
  const followerBack = await db.getAsync('SELECT * FROM followers WHERE user_id = ? AND target_id = ?', targetId, userId);
  const isBlocked = followerBack && followerBack.is_blocked;
  const isFollowing = follower && !follower.is_blocked;
  return {
    inline_keyboard: isBlocked ? [[{
      text: 'Unblock',
      callback_data: `block:${mapId}:${targetId}:0`,
    }]] : [[{
      text: isFollowing ? 'Unfollow' : 'Follow Back',
      callback_data: `follow:${mapId}:${targetId}:${isFollowing ? 0 : 1}`,
    }], [{
      text: 'Block',
      callback_data: `block:${mapId}:${targetId}:1`,
    }]],
  }
}

async function followUser(user, targetId, mapId, isBack) {
  await db.runAsync('INSERT OR IGNORE INTO followers (user_id, target_id, is_blocked) VALUES (?, ?, 0)', user.id, targetId);

  bot.sendMessage(targetId, `<b>${user.first_name}${user.last_name ? ' ' + user.last_name : ''}</b> ${isBack ? 'has followed you back' : 'is now following you'}! This means that they will see your location on their personal map. If you don't want that, you can block them.`, {
    parse_mode: 'HTML',
    reply_markup: await getReplyMarkup(targetId, mapId, user.id),
  });
}

app.post('/follow', async (req, res) => {
  const initData = validateInitData(req.body.initData);
  if (!initData) {
    res.json({ error: 'Invalid initData' });
    return;
  }
  const user = initData.user;
  const targetId = req.body.id;
  const follow = req.body.follow;
  const follower = await db.getAsync('SELECT * FROM followers WHERE user_id = ? AND target_id = ?', user.id, targetId);
  if (follower && follower.is_blocked) {
    res.json({ error: 'User blocked', blocked: true });
    return;
  }

  if (follow) {
    const map = await db.getAsync('SELECT * FROM maps WHERE code = ?', initData.chat_instance);
    if (!map) {
      res.json({ error: 'Map not found' });
      return;
    }

    const mapUser = await db.getAsync('SELECT * FROM maps_users WHERE map_id = ? AND user_id = ?', map.id, targetId);
    if (!mapUser) {
      res.json({ error: 'User not found' });
      return;
    }

    await followUser(user, targetId, map.id, false);
  } else {
    await db.runAsync('DELETE FROM followers WHERE user_id = ? AND target_id = ?', user.id, targetId);
  }
  res.json({ ok: true });
});

app.post('/hide', async (req, res) => {
  const initData = validateInitData(req.body.initData);
  if (!initData) {
    res.json({ error: 'Invalid initData' });
    return;
  }
  //db.run('UPDATE users SET latitude=NULL, longitude=NULL, country_code=NULL, city_id=NULL WHERE id = ?', user.id);
  const map = await db.getAsync('SELECT * FROM maps WHERE code = ?', initData.chat_instance);
  
  const user = initData.user;
  await db.runAsync('DELETE FROM maps_users WHERE user_id = ? AND map_id = ?', user.id, map.id);
  res.json({ ok: true });
});

app.post('/ping', async (req, res) => {
  const initData = validateInitData(req.body.initData);
  if (!initData) {
    res.json({ error: 'Invalid initData' });
    return;
  }
  const targetId = req.body.id;
  const map = await db.getAsync('SELECT * FROM maps WHERE code = ?', initData.chat_instance);
  if (!map) {
    res.json({ error: 'Map not found' });
    return;
  }

  const me = await db.getAsync('SELECT * FROM maps_users LEFT JOIN users ON users.id = maps_users.user_id WHERE map_id = ? AND user_id = ?', map.id, initData.user.id);
  if (!me) {
    res.json({ error: 'User not found' });
    return;
  }

  const mapUser = await db.getAsync('SELECT * FROM maps_users LEFT JOIN users ON users.id = maps_users.user_id WHERE map_id = ? AND user_id = ?', map.id, targetId);
  if (!mapUser) {
    res.json({ error: 'Target not found' });
    return;
  }

  if (!mapUser.is_pingable) {
    res.json({ error: 'User is not pingable' });
    return;
  }

  bot.sendMessage(mapUser.id, `<b>${me.first_name}${me.last_name ? ' ' + me.last_name : ''}</b> pinged you! They want to make sure your location is still up-to-date.`, {
    parse_mode: 'HTML',
  });
  res.json({ ok: true });
});

app.post('/geocode', async (req, res) => {
  const initData = validateInitData(req.body.initData);
  if (!initData) {
    res.json({ error: 'Invalid initData' });
    return;
  }
  const q = req.body.q || '';
  if (q.length < 2) {
    res.json({ error: 'Query is too short' });
    return;
  }
  const user = initData.user;

  const cities = await geoDb.citiesByNamePrefix(q, user.language_code);

  const regionIds = {};
  const countryCodes = {};
  for (let city of cities) {
    regionIds[city.region_id] = true;
    countryCodes[city.country_code] = true;
  }

  const regionNames = await geoDb.regionsNamesByIds(Object.keys(regionIds), user.language_code);
  const countryNames = await geoDb.countriesNamesByIds(Object.keys(countryCodes), user.language_code);
  
  res.json({ cities, regionNames, countryNames });
});

app.post('/save', async (req, res) => {
  const initData = validateInitData(req.body.initData);
  if (!initData) {
    res.json({ error: 'Invalid initData' });
    return;
  }

  const map = await db.getAsync('SELECT * FROM maps WHERE code = ?', initData.chat_instance);
  const user = initData.user;
  let { longitude, latitude, country_code, city_id, location } = req.body;

  const aligned = alignToDistrict(longitude, latitude);
  longitude = aligned[0];
  latitude = aligned[1];

  const city = await geoDb.cityByIdx(req.body.idx);
  country_code = city.country_code;
  const region_id = city.region_id;
  const distToCity = getDistance(city.latitude, city.longitude, latitude, longitude);
  const maxDist = 1.5 * Math.pow(parseInt(city.population) / 1000, 0.26);
  //console.log('Dist: ' + distToCity + 'km, pop: ' + city.population + ', fcode: '+ city.fcode);

  if (distToCity > maxDist) {
    location = (await geoDb.regionsNamesByIds(city.region_id, user.language_code))[city.region_id];
    city_id = null;
  } else {
    location = (await geoDb.citiesNamesByIds(city.id, user.language_code))[city.id];
    city_id = city.id;
  }
  

  /*try {
    let res;
    const zoom = 11;
    res = (await request('GET', `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=jsonv2&namedetails=1&layer=address&zoom=${zoom}`, {
      'User-Agent': 'FriendsBot',
      'Accept-Language': user.language_code,
    })).body;
    //console.log(res);

    let isGP = false;
    if (res.addresstype == 'municipality' && res.address && res.address.state) {
      for (let key in (res.namedetails || {})) {
        let name = res.namedetails[key];
        if (name.indexOf('городское поселение') != -1) {
          isGP = true;
        }
      }
    }

    if (res.address) {
      country_code = res.address.country_code;
      if (isGP) {
        location = res.address.state;
      } else {
        location = res.name;
        if (location.indexOf('городское поселение ') == 0) {
          location = location.replace(/городское поселение /, '');
        }
      }

      city_id = res.place_id;

      // Store city localisations
      let rows = [];
      let data = [];
      let namedetails = res.namedetails || {};
      if (isGP) {
        namedetails = { name: res.address.state };
      }
      for (let key in namedetails) {
        if (key == 'name' || (key.startsWith('name:') && key.match(/^name:[a-z]{2,3}$/))) {
          const languageCode = key.substring(5);
          rows.push('(?, ?, ?)');

          let name = namedetails[key];
          if (name.indexOf('городское поселение ') == 0) {
            name = name.replace(/городское поселение /, '');
          }
          data.push(res.place_id, languageCode, name);
        }
      }
      db.runAsync(`INSERT INTO cities (id, latitude, longitude) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude`, res.place_id, parseFloat(res.lat), parseFloat(res.lon));
      db.runAsync(`INSERT INTO cities_names (id, language_code, name) VALUES ${rows.join(', ')} ON CONFLICT(id, language_code) DO UPDATE SET name=excluded.name`, ...data);
    }
  } catch (e) {
    console.log(e);
  }*/

  await db.runAsync('UPDATE users SET latitude = ?, longitude = ?, country_code = ?, region_id = ?, city_id = ? WHERE id = ?',
    latitude, longitude, country_code, region_id, city_id, user.id);
  await db.runAsync('INSERT OR IGNORE INTO maps_users (map_id, user_id) VALUES (?, ?)', map.id, user.id);

  res.json({ longitude, latitude, country_code, location });
});

app.use(express.static('static'));
app.listen(process.env.MINIAPP_PORT, () => {
  console.log(`@${process.env.TELEGRAM_USERNAME} listening on port ${process.env.MINIAPP_PORT}`);
});