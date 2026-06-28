'use strict';

/**
 * Device handlers. Each handler wires a HomeKit service to MQTT properties
 * through the per-accessory `ctx` object provided by the platform:
 *
 *   ctx.hap                       -> homebridge HAP (Service, Characteristic)
 *   ctx.log                       -> logger
 *   ctx.publish(property, value)  -> publishes <prefix>/<id>/set/<property>
 *   ctx.subscribe(property, cb)   -> subscribes to <prefix>/<id>/status/<property>
 *
 * Values are sent as strings on the wire and parsed leniently on the way in.
 */

// ---------- value helpers ----------

function parseBool(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (['true', '1', 'on', 'yes', 'open'].includes(s)) return true;
  if (['false', '0', 'off', 'no', 'closed'].includes(s)) return false;
  return undefined;
}

function parseNum(raw) {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : undefined;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ---------- handlers ----------

function light(ctx, accessory) {
  const { Service, Characteristic } = ctx.hap;
  const svc =
    accessory.getService(Service.Lightbulb) ||
    accessory.addService(Service.Lightbulb, ctx.name);

  const on = svc.getCharacteristic(Characteristic.On);
  on.onSet((value) => ctx.publish('on', value ? 'true' : 'false'));
  ctx.subscribe('on', (raw) => {
    const v = parseBool(raw);
    if (v !== undefined) on.updateValue(v);
  });
}

function dimmer(ctx, accessory) {
  const { Service, Characteristic } = ctx.hap;
  const svc =
    accessory.getService(Service.Lightbulb) ||
    accessory.addService(Service.Lightbulb, ctx.name);

  const on = svc.getCharacteristic(Characteristic.On);
  const bri = svc.getCharacteristic(Characteristic.Brightness);

  on.onSet((value) => ctx.publish('on', value ? 'true' : 'false'));
  bri.onSet((value) => ctx.publish('brightness', String(value)));

  ctx.subscribe('on', (raw) => {
    const v = parseBool(raw);
    if (v !== undefined) on.updateValue(v);
  });
  ctx.subscribe('brightness', (raw) => {
    const n = parseNum(raw);
    if (n !== undefined) bri.updateValue(clamp(Math.round(n), 0, 100));
  });
}

function cover(ctx, accessory) {
  const { Service, Characteristic } = ctx.hap;
  const svc =
    accessory.getService(Service.WindowCovering) ||
    accessory.addService(Service.WindowCovering, ctx.name);

  const target = svc.getCharacteristic(Characteristic.TargetPosition);
  const current = svc.getCharacteristic(Characteristic.CurrentPosition);
  const state = svc.getCharacteristic(Characteristic.PositionState);
  state.updateValue(Characteristic.PositionState.STOPPED);

  // HomeKit position: 0 = closed, 100 = open.
  target.onSet((value) => ctx.publish('position', String(value)));

  // Client reports the live position.
  ctx.subscribe('position', (raw) => {
    const n = parseNum(raw);
    if (n === undefined) return;
    const pos = clamp(Math.round(n), 0, 100);
    current.updateValue(pos);
    target.updateValue(pos);
    state.updateValue(Characteristic.PositionState.STOPPED);
  });

  // Optional movement state: "opening" | "closing" | "stopped".
  ctx.subscribe('state', (raw) => {
    const s = String(raw).trim().toLowerCase();
    if (s === 'opening' || s === 'increasing')
      state.updateValue(Characteristic.PositionState.INCREASING);
    else if (s === 'closing' || s === 'decreasing')
      state.updateValue(Characteristic.PositionState.DECREASING);
    else state.updateValue(Characteristic.PositionState.STOPPED);
  });
}

function thermostat(ctx, accessory) {
  const { Service, Characteristic } = ctx.hap;
  const svc =
    accessory.getService(Service.Thermostat) ||
    accessory.addService(Service.Thermostat, ctx.name);

  const curTemp = svc.getCharacteristic(Characteristic.CurrentTemperature);
  const tgtTemp = svc.getCharacteristic(Characteristic.TargetTemperature);
  const curMode = svc.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
  const tgtMode = svc.getCharacteristic(Characteristic.TargetHeatingCoolingState);

  tgtTemp.setProps({ minValue: 5, maxValue: 35, minStep: 0.5 });

  const MODE_TO_TEXT = { 0: 'off', 1: 'heat', 2: 'cool', 3: 'auto' };
  const TEXT_TO_TARGET = {
    off: Characteristic.TargetHeatingCoolingState.OFF,
    heat: Characteristic.TargetHeatingCoolingState.HEAT,
    cool: Characteristic.TargetHeatingCoolingState.COOL,
    auto: Characteristic.TargetHeatingCoolingState.AUTO,
  };
  const TEXT_TO_CURRENT = {
    off: Characteristic.CurrentHeatingCoolingState.OFF,
    heat: Characteristic.CurrentHeatingCoolingState.HEAT,
    cool: Characteristic.CurrentHeatingCoolingState.COOL,
  };

  tgtTemp.onSet((value) => ctx.publish('targetTemperature', String(value)));
  tgtMode.onSet((value) => ctx.publish('targetMode', MODE_TO_TEXT[value] || 'off'));

  ctx.subscribe('currentTemperature', (raw) => {
    const n = parseNum(raw);
    if (n !== undefined) curTemp.updateValue(n);
  });
  ctx.subscribe('targetTemperature', (raw) => {
    const n = parseNum(raw);
    if (n !== undefined) tgtTemp.updateValue(clamp(n, 5, 35));
  });
  ctx.subscribe('currentMode', (raw) => {
    const v = TEXT_TO_CURRENT[String(raw).trim().toLowerCase()];
    if (v !== undefined) curMode.updateValue(v);
  });
  ctx.subscribe('targetMode', (raw) => {
    const v = TEXT_TO_TARGET[String(raw).trim().toLowerCase()];
    if (v !== undefined) tgtMode.updateValue(v);
  });
}

function speaker(ctx, accessory) {
  const { Service, Characteristic } = ctx.hap;

  // Prefer the semantically correct SmartSpeaker service when available.
  if (Service.SmartSpeaker) {
    const svc =
      accessory.getService(Service.SmartSpeaker) ||
      accessory.addService(Service.SmartSpeaker, ctx.name);

    const tgt = svc.getCharacteristic(Characteristic.TargetMediaState);
    const cur = svc.getCharacteristic(Characteristic.CurrentMediaState);

    const MEDIA_TEXT = { 0: 'play', 1: 'pause', 2: 'stop' };
    const TEXT_MEDIA = { play: 0, pause: 1, stop: 2, playing: 0, paused: 1, stopped: 2 };

    tgt.onSet((value) => ctx.publish('play', MEDIA_TEXT[value] || 'stop'));
    ctx.subscribe('play', (raw) => {
      const v = TEXT_MEDIA[String(raw).trim().toLowerCase()];
      if (v !== undefined) {
        cur.updateValue(v);
        tgt.updateValue(v);
      }
    });

    // Volume + Mute are optional characteristics on SmartSpeaker.
    const vol = svc.getCharacteristic(Characteristic.Volume);
    const mute = svc.getCharacteristic(Characteristic.Mute);
    vol.onSet((value) => ctx.publish('volume', String(value)));
    mute.onSet((value) => ctx.publish('mute', value ? 'true' : 'false'));
    ctx.subscribe('volume', (raw) => {
      const n = parseNum(raw);
      if (n !== undefined) vol.updateValue(clamp(Math.round(n), 0, 100));
    });
    ctx.subscribe('mute', (raw) => {
      const v = parseBool(raw);
      if (v !== undefined) mute.updateValue(v);
    });
    return;
  }

  // Fallback: expose as a Lightbulb where On = play and Brightness = volume.
  ctx.log.warn(
    `"${ctx.name}": SmartSpeaker service unavailable, falling back to a Lightbulb (On=play, Brightness=volume).`
  );
  const svc =
    accessory.getService(Service.Lightbulb) ||
    accessory.addService(Service.Lightbulb, ctx.name);
  const on = svc.getCharacteristic(Characteristic.On);
  const bri = svc.getCharacteristic(Characteristic.Brightness);
  on.onSet((value) => ctx.publish('play', value ? 'play' : 'pause'));
  bri.onSet((value) => ctx.publish('volume', String(value)));
  ctx.subscribe('play', (raw) => {
    const s = String(raw).trim().toLowerCase();
    on.updateValue(s === 'play' || s === 'playing' || s === 'true');
  });
  ctx.subscribe('volume', (raw) => {
    const n = parseNum(raw);
    if (n !== undefined) bri.updateValue(clamp(Math.round(n), 0, 100));
  });
}

const HANDLERS = { light, dimmer, cover, speaker, thermostat };

function primaryService(hap, type) {
  const S = hap.Service;
  switch (type) {
    case 'light':
    case 'dimmer':
      return S.Lightbulb;
    case 'cover':
      return S.WindowCovering;
    case 'thermostat':
      return S.Thermostat;
    case 'speaker':
      return S.SmartSpeaker || S.Lightbulb;
    default:
      return null;
  }
}

module.exports = { HANDLERS, primaryService };
