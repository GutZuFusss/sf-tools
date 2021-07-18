const DATABASE_PARAMS_V5 = [
    'sftools',
    1,
    {
        players: {
            key: ['identifier', 'timestamp'],
            indexes: {
                own: 'own',
                identifier: 'identifier',
                timestamp: 'timestamp',
                group: 'group',
                prefix: 'prefix'
            }
        },
        groups: {
            key: ['identifier', 'timestamp'],
            indexes: {
                own: 'own',
                identifier: 'identifier',
                timestamp: 'timestamp',
                prefix: 'prefix'
            }
        },
        trackers: {
            key: 'identifier'
        }
    }
];

const DATABASE_PARAMS_V1 = [
    'database',
    2,
    {
        files: {
            key: 'timestamp'
        },
        profiles: {
            key: 'identifier'
        }
    }
];

function _bindOnSuccessOnError (event, resolve, reject) {
    if (resolve) event.onsuccess = () => resolve(event.result);
    if (reject) event.onerror = () => reject(event.error);
    return event;
}

class IndexedDBWrapper {
    static delete (name) {
        return new Promise((resolve, reject) => _bindOnSuccessOnError(
            indexedDB.deleteDatabase(name), resolve, reject
        ));
    }

    static exists (name, version) {
        return new Promise((resolve, reject) => {
            let openRequest = indexedDB.open(name, version);
            openRequest.onsuccess = () => resolve(true);
            openRequest.onerror = () => resolve(false);
            openRequest.onupgradeneeded = event => {
                event.target.transaction.abort();
                resolve(false);
            };
        });
    }

    constructor (name, version, stores) {
        this.name = name;
        this.version = version;
        this.stores = stores;
        this.database = null;
    }

    store (store, index) {
        let databaseStore = this.database.transaction(store, 'readwrite').objectStore(store);
        if (index) {
            return databaseStore.index(index);
        } else {
            return databaseStore;
        }
    }

    open () {
        return new Promise((resolve, reject) => {
            let openRequest = _bindOnSuccessOnError(indexedDB.open(this.name, this.version), resolve, reject);

            openRequest.onupgradeneeded = (event) => {
                let database = openRequest.result;
                for (let [ name, { key, indexes } ] of Object.entries(this.stores)) {
                    let store = database.createObjectStore(name, { keyPath: key });
                    if (indexes) {
                        for (let [ indexName, indexKey ] of Object.entries(indexes)) {
                            store.createIndex(indexName, indexKey);
                        }
                    }
                }
            }
        }).then(db => {
            this.database = db;
            return this;
        });
    }

    close () {
        return new Promise((resolve, reject) => {
            this.database.close();
            resolve();
        });
    }

    set (store, value) {
        return new Promise((resolve, reject) => _bindOnSuccessOnError(
            this.store(store).put(value), resolve, reject
        ));
    }

    get (store, key) {
        return new Promise((resolve, reject) => _bindOnSuccessOnError(
            this.store(store).get(key), resolve, reject
        ));
    }

    remove (store, key) {
        return new Promise((resolve, reject) => _bindOnSuccessOnError(
            this.store(store).delete(key), resolve, reject
        ));
    }

    where (store, index, query) {
        return new Promise((resolve, reject) => {
            let items = [];
            let cursorRequest = this.store(store, index).openCursor(query);
            cursorRequest.onerror = () => resolve([]);
            cursorRequest.onsuccess = event => {
                let cursor = event.target.result;
                if (cursor) {
                    items.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(items);
                }
            };
        });
    }
}

class MigrationUtils {
    static migrateGroup (group) {
        group.identifier = group.id;
        delete group.id;

        group.own = group.own ? 1 : 0;

        return group;
    }

    static migratePlayer (player) {
        player.identifier = player.id;
        delete player.id;

        player.own = player.own ? 1 : 0;

        let group = player.save[player.own ? 435 : 161];
        if (group) {
            player.group = `${player.prefix}_g${group}`
        }

        return player;
    }
}

class DatabaseUtils {
    static async createSession(slot) {
        DATABASE_PARAMS_V1[0] = DatabaseUtils.getNameFromSlot(slot);

        let database = await new IndexedDBWrapper(... DATABASE_PARAMS_V5).open();

        if (await IndexedDBWrapper.exists(... DATABASE_PARAMS_V1)) {
            let migratedDatabase = await new IndexedDBWrapper(... DATABASE_PARAMS_V1).open();
            let migratedFiles = await migratedDatabase.where('files');

            for (let file of migratedFiles) {
                for (let player of file.players) {
                    await database.set('players', MigrationUtils.migratePlayer(player));
                }

                for (let group of file.groups) {
                    await database.set('groups', MigrationUtils.migrateGroup(group));
                }
            }

            let migratedTrackers = await migratedDatabase.where('profiles');
            for (let tracker of migratedTrackers) {
                await database.set('trackers', tracker);
            }

            migratedDatabase.close();
            //await _databaseDelete(DATABASE_PARAMS_V1[0]);
        }

        return database;
    }

    static async createTemporarySession () {
        return null;
    }

    static getNameFromSlot (slot = 0) {
        if (slot) {
            return `database_${slot}`
        } else {
            return 'database'
        }
    }

    static createProfileFilter (filter) {
        if (filter) {
            let { name, mode, value } = filter;

            let range = null;
            if (mode == 'below') {
                range = IDBKeyRange.upperBound(... value);
            } else if (mode == 'above') {
                range = IDBKeyRange.lowerBound(... value);
            } else if (mode == 'between') {
                range = IDBKeyRange.bound(... value);
            } else {
                range = IDBKeyRange.only(... value);
            }

            return [name, range];
        } else {
            return [];
        }
    }
}

const DEFAULT_PROFILE = Object.freeze({
    temporary: false,
    slot: 0,
    filters: {
        players: null,
        groups: null
    }
});

const DatabaseManager = new (class {
    constructor () {
        this.reset();
    }

    reset () {
        this.Database = null;
        this.Options = {};

        this.Players = {};
        this.Groups = {};
    }

    load (profile = DEFAULT_PROFILE) {
        this.reset();
        return new Promise(async (resolve, reject) => {
            if (profile.temporary) {
                this.Database = await DatabaseUtils.createTemporarySession();
            } else {
                this.Database = await DatabaseUtils.createSession(profile.slot);

                let players = await this.Database.where(
                    'players',
                    ... DatabaseUtils.createProfileFilter(profile.filters?.players)
                );

                let groups = await this.Database.where(
                    'groups',
                    ... DatabaseUtils.createProfileFilter(profile.filters?.groups)
                );

                groups.forEach(group => this.addGroup(group));
                players.forEach(group => this.addPlayer(group));
                this.updateLists();
            }

            resolve();
        });
    }

    addPlayer (data) {
        let player = new Proxy({
            Data: data,
            Identifier: data.identifier,
            Timestamp: data.timestamp,
            Own: data.own,
            Name: data.name,
            Prefix: data.prefix.replace(/\_/g, ' '),
            Class: data.class
        }, {
            get: function (target, prop) {
                if (prop == 'Data' || prop == 'Identifier' || prop == 'Timestamp' || prop == 'Own' || prop == 'Name' || prop == 'Prefix' || prop == 'Class') {
                    return target[prop];
                } else if (prop == 'IsProxy') {
                    return true;
                } else {
                    return DatabaseManager.getPlayer(target.Identifier, target.Timestamp)[prop];
                }
            }
        });

        // Increment counter in group
        if (this.Groups[data.identifier]?.[data.timestamp]) {
            this.Groups[data.identifier][data.timestamp].MembersPresent++;
        }

        this.registerModel('Players', data.identifier, data.timestamp, player);
    }

    addGroup (data) {
        this.registerModel('Groups', data.identifier, data.timestamp, new SFGroup(data));
    }

    registerModel (type, identifier, timestamp, model) {
        if (!this[type][identifier]) this[type][identifier] = {};
        this[type][identifier][timestamp] = model;
    }

    updateLists () {

    }

    hasPlayer (id, timestamp) {
        return this.Players[id] && (timestamp ? this.Players[id][timestamp] : true) ? true : false;
    }

    // Check if group exists
    hasGroup (id, timestamp) {
        return this.Groups[id] && (timestamp ? this.Groups[id][timestamp] : true) ? true : false;
    }

    // Get player
    getPlayer (id, timestamp) {
        let player = this.Players[id];
        if (player && timestamp) {
            return this.loadPlayer(player[timestamp]);
        } else {
            return player;
        }
    }

    // Get group
    getGroup (id, timestamp) {
        if (timestamp && this.Groups[id]) {
            return this.Groups[id][timestamp];
        } else {
            return this.Groups[id];
        }
    }

    loadPlayer (lazyPlayer) {
        if (lazyPlayer && lazyPlayer.IsProxy) {
            let { Identifier: identifier, Timestamp: timestamp, Data: data, Own: own } = lazyPlayer;

            // Get player
            let player = own ? new SFOwnPlayer(data) : new SFOtherPlayer(data);

            // Get player group
            let group = this.getGroup(player.Group.Identifier, timestamp);
            if (group) {
                // Find index of player in the group
                let gi = group.Members.findIndex(i => i == identifier);

                // Add guild information
                player.Group.Group = group;
                player.Group.Role = group.Roles[gi];
                player.Group.Index = gi;
                player.Group.Rank = group.Rank;
                player.Group.ReadyDefense = group.States[gi] == 1 || group.States[gi] == 3;
                player.Group.ReadyAttack = group.States[gi] > 1;

                if (group.Own) {
                    player.Group.Own = true;
                    player.Group.Pet = group.Pets[gi];
                    player.Group.Treasure = group.Treasures[gi];
                    player.Group.Instructor = group.Instructors[gi];

                    if (!player.Fortress.Knights && group.Knights) {
                        player.Fortress.Knights = group.Knights[gi];
                    }
                } else {
                    player.Group.Pet = group.Pets[gi];
                }
            }

            return player;
        } else {
            return lazyPlayer;
        }
    }
})();
