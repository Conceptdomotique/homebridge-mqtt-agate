'use strict';

const net = require('net');
const http = require('http');
const Aedes = require('aedes');

/**
 * Embedded MQTT broker (server) based on Aedes.
 * Exposes a plain TCP listener and, optionally, a WebSocket listener.
 *
 * If username/password are provided in the config, clients (and our own
 * internal bridge client) must authenticate with them.
 */
class Broker {
  constructor(log, options) {
    this.log = log;
    this.options = Object.assign(
      {
        port: 1883,
        host: '0.0.0.0',
        wsPort: 0,
        username: undefined,
        password: undefined,
      },
      options || {}
    );

    this.aedes = new Aedes();
    this.tcpServer = null;
    this.httpServer = null;
    this.wsServer = null;

    this._setupAuth();
    this._setupLogging();
  }

  _setupAuth() {
    const { username, password } = this.options;
    if (!username && !password) {
      return; // open broker
    }
    this.aedes.authenticate = (client, user, pass, callback) => {
      const passStr = pass ? pass.toString() : '';
      const ok = user === username && passStr === password;
      if (!ok) {
        this.log.warn(`MQTT auth refused for client "${client ? client.id : '?'}"`);
        const err = new Error('Auth error');
        err.returnCode = 4; // bad username or password
        return callback(err, false);
      }
      return callback(null, true);
    };
  }

  _setupLogging() {
    this.aedes.on('client', (c) => this.log.debug(`MQTT client connected: ${c ? c.id : '?'}`));
    this.aedes.on('clientDisconnect', (c) =>
      this.log.debug(`MQTT client disconnected: ${c ? c.id : '?'}`)
    );
    this.aedes.on('clientError', (c, err) =>
      this.log.debug(`MQTT client error (${c ? c.id : '?'}): ${err.message}`)
    );
  }

  start() {
    return new Promise((resolve, reject) => {
      this.tcpServer = net.createServer(this.aedes.handle);
      this.tcpServer.once('error', reject);
      this.tcpServer.listen(this.options.port, this.options.host, () => {
        this.tcpServer.removeListener('error', reject);
        this.log.info(
          `MQTT broker (TCP) listening on ${this.options.host}:${this.options.port}` +
            (this.options.username ? ' [auth enabled]' : ' [no auth]')
        );
        this._maybeStartWebSocket().then(resolve).catch(reject);
      });
    });
  }

  _maybeStartWebSocket() {
    return new Promise((resolve, reject) => {
      if (!this.options.wsPort) {
        return resolve();
      }
      let ws;
      try {
        ws = require('ws');
      } catch (e) {
        this.log.warn('WebSocket support requested but "ws" is not installed; skipping.');
        return resolve();
      }
      this.httpServer = http.createServer();
      this.wsServer = new ws.Server({ server: this.httpServer });
      this.wsServer.on('connection', (socket) => {
        const stream = ws.createWebSocketStream(socket);
        this.aedes.handle(stream);
      });
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.options.wsPort, this.options.host, () => {
        this.httpServer.removeListener('error', reject);
        this.log.info(
          `MQTT broker (WebSocket) listening on ${this.options.host}:${this.options.wsPort}`
        );
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      const closeTcp = () =>
        this.tcpServer ? new Promise((r) => this.tcpServer.close(r)) : Promise.resolve();
      const closeHttp = () =>
        this.httpServer ? new Promise((r) => this.httpServer.close(r)) : Promise.resolve();
      Promise.all([closeTcp(), closeHttp()]).then(() => {
        this.aedes.close(() => resolve());
      });
    });
  }
}

module.exports = Broker;
