const sqlite3 = require('sqlite3').verbose();

class Database extends sqlite3.Database {
  constructor(name) {
    super(`./${name}.sqlite3`);

    // Create async methods instead of callbacks
    for (let fnName of ['run', 'all', 'get', 'exec']) {
      this[fnName + 'Async'] = (sql, ...params) => {
        return new Promise((resolve, reject) => {
          const t0 = Date.now();
          this[fnName](sql, ...params, (err, res) => {
            this.lastQueryTime = Date.now() - t0;
            if (err) {
              reject(err);
            } else {
              resolve(res);
            }
          });
        });
      }
    }
  }

  createTables(tables) {
    const queries = [];
    for (let tableName in tables) {
      const table = tables[tableName];
      const columns = table.columns;
      queries.push(`CREATE TABLE IF NOT EXISTS ${tableName} (` + Object.keys(columns).map(columnName => {
        const column = columns[columnName];
        if (typeof column == 'string') {
          return `${columnName} ${column}`;
        }
        return `${columnName} ${column.type}` +
          (column.notNull ? ' NOT NULL' : '') +
          (column.default ? ' DEFAULT ' + column.default : '') +
          (column.primary ? ' PRIMARY KEY' : '');
      }).concat(table.primary ? [`PRIMARY KEY (${table.primary.join(', ')})`] : []).join(', ') + `);`);

      for (let index of (table.indices || [])) {
        const name = index.name || `${tableName}_idx_${index.columns.map(column => column.split(' ')[0]).join('_')}`;
        queries.push(`CREATE${index.unique ? ' UNIQUE' : ''} INDEX IF NOT EXISTS ${name} ON ${tableName} (${index.columns.join(', ')});`);
      }
    }
    return this.execAsync(queries.join('\n'));
  }

  bulkInsert(tableName, columns, { ignore = false, batchSize = 3000 } = {}) {
    let args = [], params = [];
    return async (...values) => {
      if (values.length) {
        args.push('(' + '?'.repeat(values.length).split('').join(', ') + ')');
        params.push(...values);
      }

      if (args.length >= batchSize || (args.length > 0 && !values.length)) {
        await this.runAsync(`INSERT${ignore ? ' OR IGNORE' : ''} INTO ${tableName} (${columns.join(', ')}) VALUES ${args.join(', ')}`, params);
        args = [];
        params = [];
      }
    };
  }
}

class BotDb extends Database {
  constructor() {
    super('db');
  }
}

class GeonamesDb extends Database {
  constructor() {
    super('geonames');
  }

  createTables() {
    return super.createTables({
      cities: {
        columns: {
          id: { type: 'INT', primary: true },
          country_code: { type: 'TEXT', notNull: true },
          region_id: 'INT',
          idx: { type: 'INT', notNull: true },
          fcode: { type: 'TEXT', notNull: true },
          population: { type: 'INT', notNull: true },
          latitude: { type: 'REAL', notNull: true },
          longitude: { type: 'REAL', notNull: true },
        },
        indices: [{
          unique: true,
          columns: ['idx'],
        }],
      },
      countries_names: {
        columns: {
          code: { type: 'TEXT', notNull: true },
          language_code: { type: 'TEXT', notNull: true },
          name: { type: 'TEXT', notNull: true },
        },
        primary: ['code', 'language_code'],
      },
      regions_names: {
        columns: {
          id: { type: 'INT', notNull: true },
          language_code: { type: 'TEXT', notNull: true },
          name: { type: 'TEXT', notNull: true },
        },
        primary: ['id', 'language_code'],
        indices: [{
          columns: ['name COLLATE NOCASE'],
        }]
      },
      cities_names: {
        columns: {
          id: { type: 'INT', notNull: true },
          language_code: { type: 'TEXT', notNull: true },
          name: { type: 'TEXT', notNull: true },
          norm_name: { type: 'TEXT', notNull: true },
        },
        primary: ['id', 'language_code'],
        indices: [{
          columns: ['norm_name COLLATE NOCASE'],
        }]
      },
    });
  }

  normName(name) {
    return name.replace(/\P{L}+/gu, '').normalize('NFKC').toLocaleLowerCase(); // remove all non-letters, normalize, and lower-case
  }

  cityByIdx(idx) {
    return this.getAsync('SELECT * FROM cities WHERE idx = ?', idx);
  }

  async citiesByNamePrefix(prefix, preferredLanguage, offset = 0, limit = 6) {
    const cities = await this.allAsync('SELECT *, GROUP_CONCAT(name, "|") AS name_concat, GROUP_CONCAT(language_code) AS lang_concat FROM cities_names LEFT JOIN cities ON cities.id = cities_names.id WHERE norm_name LIKE ? GROUP BY cities.id ORDER BY population DESC LIMIT ?, ?', this.normName(prefix) + '%', offset, limit);
    for (let city of cities) { // All names in name_concat will match query, but we should prioritize preferredLanguage, English and default name
      const langs = city.lang_concat.split(',');
      const names = city.name_concat.split('|');
      
      let maxPriority = -2;
      for (let i = 0; i < langs.length; i++) {
        let priority = ['en', '', preferredLanguage].indexOf(langs[i]);
        if (priority > maxPriority) {
          city.name = names[i];
          city.language_code = langs[i];
          maxPriority = priority;
        }
      }
      delete city.lang_concat;
      delete city.name_concat;
    }
    return cities;
  }

  async preferredNamesByIds(tableName, idName, ids, preferredLanguage) {
    const names = {};
    if (Array.isArray(ids) && !ids.length) {
      return names;
    }
    const rows = await this.allAsync(`SELECT * FROM ${tableName} WHERE ${idName}${Array.isArray(ids) ? ' IN (' + ids.map(() => '?').join(',') + ')' : ' == ?'} AND (language_code == "" OR language_code == ?)`,
       ...(Array.isArray(ids) ? ids : [ids]), preferredLanguage);

    for (let row of rows) {
      if (!(row[idName] in names) || (row.language_code == preferredLanguage)) {
        names[row[idName]] = row.name;
      }
    }
    return names;
  }

  countriesNamesByIds(codes, preferredLanguage) {
    return this.preferredNamesByIds('countries_names', 'code', codes, preferredLanguage);
  }

  regionsNamesByIds(ids, preferredLanguage) {
    return this.preferredNamesByIds('regions_names', 'id', ids, preferredLanguage);
  }

  citiesNamesByIds(ids, preferredLanguage) {
    return this.preferredNamesByIds('cities_names', 'id', ids, preferredLanguage);
  }
}

module.exports = { BotDb, GeonamesDb };