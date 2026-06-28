# homebridge-mqtt-agate — « MQTT Agate »

Plugin **plateforme** Homebridge qui **héberge son propre broker MQTT** (serveur).
Ton client domotique (Agate) se connecte directement dessus : pas besoin d'installer
Mosquitto à côté. Le plugin expose à HomeKit des **lampes**, **variateurs (dimmer)**,
**volets**, **musique (enceinte)** et **thermostats**, et fait le pont avec MQTT dans
les deux sens.

```
   HomeKit  <—HAP—>  Homebridge + ce plugin  <—MQTT—>  Agate (client)
                         (broker MQTT intégré)
```

## Installation

Copie le dossier dans le répertoire des plugins Homebridge puis installe les
dépendances, ou installe-le comme un plugin local :

```bash
cd homebridge-mqtt-agate
npm install
# puis lien local vers Homebridge :
npm link        # optionnel selon ton setup
```

En production, le plus simple est de le publier/installer sous le nom
`homebridge-mqtt-agate` et de le configurer via **Homebridge Config UI X**
(le plugin fournit un `config.schema.json`, l'UI affiche un formulaire).

## Configuration

Voir `config.example.json`. Bloc principal :

| Champ | Rôle | Défaut |
|---|---|---|
| `mqtt.port` | Port TCP du broker | `1883` |
| `mqtt.host` | Interface d'écoute (`0.0.0.0` = toutes) | `0.0.0.0` |
| `mqtt.wsPort` | Port WebSocket (0 = désactivé) | `0` |
| `mqtt.username` / `mqtt.password` | Authentification (optionnelle) | — |
| `mqtt.topicPrefix` | Préfixe des topics | `homebridge` |
| `accessories[]` | Liste des appareils (`id`, `name`, `type`) | — |

Types disponibles : `light`, `dimmer`, `cover`, `speaker`, `thermostat`.

## Convention de topics

Pour chaque accessoire d'identifiant `<id>` :

- **Commandes** (HomeKit → ton client) : le plugin **publie** sur
  `…/<id>/set/<propriété>`. Ton client doit **s'abonner** à `…/<id>/set/#`.
- **États** (ton client → HomeKit) : ton client **publie** sur
  `…/<id>/status/<propriété>`. Le plugin y est **abonné**.

Préfixe par défaut `homebridge`. Les valeurs circulent en texte simple.
À la réception, le plugin est tolérant : `true/false`, `1/0`, `on/off`,
`open/closed` sont tous acceptés pour les booléens.

### Propriétés par type

| Type | Propriété | Sens | Valeurs |
|---|---|---|---|
| `light` | `on` | set + status | `true` / `false` |
| `dimmer` | `on` | set + status | `true` / `false` |
| | `brightness` | set + status | `0`–`100` |
| `cover` | `position` | set + status | `0`=fermé … `100`=ouvert |
| | `state` | status (option.) | `opening` / `closing` / `stopped` |
| `speaker` | `play` | set + status | `play` / `pause` / `stop` |
| | `volume` | set + status | `0`–`100` |
| | `mute` | set + status | `true` / `false` |
| `thermostat` | `targetTemperature` | set + status | °C (ex. `21.5`) |
| | `currentTemperature` | status | °C |
| | `targetMode` | set + status | `off`/`heat`/`cool`/`auto` |
| | `currentMode` | status | `off`/`heat`/`cool` |

### Exemple d'échange (volet `volet_sejour`)

L'utilisateur ouvre le volet à 60 % depuis l'app Maison :

```
homebridge/volet_sejour/set/position   ->  "60"      (publié par le plugin)
```

Agate bouge le volet puis renvoie sa position réelle :

```
homebridge/volet_sejour/status/state     <-  "opening"
homebridge/volet_sejour/status/position  <-  "60"      (à l'arrêt)
homebridge/volet_sejour/status/state     <-  "stopped"
```

## Test rapide en ligne de commande

Avec `mosquitto_pub`/`mosquitto_sub` (ou n'importe quel client), une fois
Homebridge lancé :

```bash
# voir ce que HomeKit envoie
mosquitto_sub -h <ip-homebridge> -t 'homebridge/#' -v -u agate -P change-me

# simuler un retour d'état de la lampe
mosquitto_pub -h <ip-homebridge> -t 'homebridge/lampe_salon/status/on' -m true -u agate -P change-me
```

## Notes

- **Musique** : le plugin utilise le service HomeKit `SmartSpeaker` quand il est
  disponible (lecture/pause + volume + mute). L'app Maison gère ce service de façon
  limitée selon les versions ; en repli automatique, l'enceinte est exposée comme
  une ampoule (On = lecture, Luminosité = volume).
- Les états ne sont pas inventés par le plugin : c'est ton client qui fait foi en
  publiant sur `…/status/…`. Publie en `retain` côté client si tu veux que HomeKit
  retrouve le dernier état après un redémarrage.
- Sécurité : si le broker écoute sur `0.0.0.0`, active de préférence
  `username`/`password` et limite l'accès réseau.

## Licence

MIT
