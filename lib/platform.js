'use strict';

const mqtt = require('mqtt');
const Broker = require('./broker');
const { HANDLERS, primaryService } = require('./devices');

const PLUGIN_NAME = 'homebridge-mqtt-agate';
const PLATFORM_NAME = 'MqttAgate';

class MqttServerPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hap = api.hap;

    this.accessories = new Map(); // uuid -> cached PlatformAccessory

    this.mqttConfig = Object.assign(
      { port: 1883, host: '0.0.0.0', wsPort: 0, topicPrefix: 'homebridge' },
      this.config.mqtt || {}
    );
    this.prefix = this.mqttConfig.topicPrefix || 'homebridge';

    this.broker = null;
    this.client = null;
    this.subscriptions = new Map(); // topic -> [cb]

    this.api.on('didFinishLaunching', () => this._launch());
    this.api.on('shutdown', () => this._shutdown());
  }

  // Called by Homebridge for every cached accessory at startup.
  configureAccessory(accessory) {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  async _launch() {
    try {
      this.broker = new Broker(this.log, this.mqttConfig);
      await this.broker.start();
      await this._connectInternalClient();
      this._setupAccessories();
    } catch (err) {
      this.log.error(`Failed to start MQTT server platform: ${err.message}`);
    }
  }

  _connectInternalClient() {
    return new Promise((resolve, reject) => {
      const url = `mqtt://127.0.0.1:${this.mqttConfig.port}`;
      const opts = { clientId: 'homebridge-internal-' + Math.random().toString(16).slice(2, 8) };
      if (this.mqttConfig.username) opts.username = this.mqttConfig.username;
      if (this.mqttConfig.password) opts.password = this.mqttConfig.password;

      this.client = mqtt.connect(url, opts);

      this.client.on('connect', () => {
        this.log.info('Internal bridge client connected to embedded broker.');
        resolve();
      });
      this.client.on('error', (err) => {
        this.log.error(`Internal bridge client error: ${err.message}`);
        reject(err);
      });
      this.client.on('message', (topic, payload) => {
        const cbs = this.subscriptions.get(topic);
        if (!cbs) return;
        const value = payload.toString();
        for (const cb of cbs) {
          try {
            cb(value);
          } catch (e) {
            this.log.debug(`Handler error on ${topic}: ${e.message}`);
          }
        }
      });
    });
  }

  _subscribe(topic, cb) {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, []);
      this.client.subscribe(topic, (err) => {
        if (err) this.log.error(`Subscribe failed for ${topic}: ${err.message}`);
      });
    }
    this.subscriptions.get(topic).push(cb);
  }

  _publish(topic, value) {
    if (!this.client) return;
    this.client.publish(topic, String(value), { qos: 0, retain: false });
    this.log.debug(`-> ${topic} = ${value}`);
  }

  _setupAccessories() {
    const defs = Array.isArray(this.config.accessories) ? this.config.accessories : [];
    const validUuids = new Set();

    for (const def of defs) {
      if (!def || !def.id || !def.name || !def.type) {
        this.log.warn(`Skipping accessory with missing id/name/type: ${JSON.stringify(def)}`);
        continue;
      }
      const handler = HANDLERS[def.type];
      if (!handler) {
        this.log.warn(`Unknown accessory type "${def.type}" for "${def.name}".`);
        continue;
      }

      const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:${def.id}`);
      validUuids.add(uuid);

      let accessory = this.accessories.get(uuid);
      let isNew = false;
      if (!accessory) {
        accessory = new this.api.platformAccessory(def.name, uuid);
        isNew = true;
      }
      accessory.displayName = def.name;
      accessory.context.def = def;
      this._setAccessoryInfo(accessory, def);
      this._pruneServices(accessory, def);

      const ctx = {
        hap: this.hap,
        log: this.log,
        name: def.name,
        publish: (property, value) =>
          this._publish(`${this.prefix}/${def.id}/set/${property}`, value),
        subscribe: (property, cb) =>
          this._subscribe(`${this.prefix}/${def.id}/status/${property}`, cb),
      };

      try {
        handler(ctx, accessory);
      } catch (e) {
        this.log.error(`Failed to configure "${def.name}": ${e.message}`);
        continue;
      }

      if (isNew) {
        this.log.info(`Adding accessory: ${def.name} (${def.type})`);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      } else {
        this.log.info(`Updating accessory: ${def.name} (${def.type})`);
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    // Remove accessories that are cached but no longer in config.
    for (const [uuid, accessory] of this.accessories) {
      if (!validUuids.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  _setAccessoryInfo(accessory, def) {
    const { Service, Characteristic } = this.hap;
    const info =
      accessory.getService(Service.AccessoryInformation) ||
      accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Concept Domotique')
      .setCharacteristic(Characteristic.Model, `MQTT ${def.type}`)
      .setCharacteristic(Characteristic.SerialNumber, def.id);
  }

  // Drop a previously-created primary service if the type changed.
  _pruneServices(accessory, def) {
    const keep = primaryService(this.hap, def.type);
    const Info = this.hap.Service.AccessoryInformation;
    for (const svc of [...accessory.services]) {
      if (svc.UUID === Info.UUID) continue;
      if (keep && svc.UUID === keep.UUID) continue;
      accessory.removeService(svc);
    }
  }

  async _shutdown() {
    try {
      if (this.client) await new Promise((r) => this.client.end(true, {}, r));
      if (this.broker) await this.broker.stop();
      this.log.info('MQTT server stopped.');
    } catch (e) {
      this.log.debug(`Shutdown error: ${e.message}`);
    }
  }
}

module.exports = { MqttServerPlatform, PLUGIN_NAME, PLATFORM_NAME };
