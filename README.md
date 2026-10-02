<span align="center">

# Homebridge Companion plugin for IRremoteESP8266

</span>

This plugin provides homebridge support form [IRremoteESP8266 library](https://github.com/crankyoldgit/IRremoteESP8266)

To use your IRremote over MQTT and to homebridge using this plugin, you must have [This Arduino Sketch](https://github.com/crankyoldgit/IRremoteESP8266/blob/master/examples/IRMQTTServer/IRMQTTServer.ino) flashed to your ESP8266 device.

### Features

The accessory is exposed as a HomeKit **HeaterCooler** plus a few helper switches:

| Control | Description |
| --- | --- |
| Power / Mode / Temperature / Fan | Standard HeaterCooler controls mapped to `power`, `mode`, `temp` and `fanspeed`. |
| **Vertical Swing** | Dedicated switch that toggles the louvres between `auto` (continuous swing) and `off`. |
| **Swing Lowest / Low / Middle / High / Highest** | Mutually-exclusive switches that park the louvres at a fixed vertical position (`swingv` = `lowest` … `highest`). |
| **Horizontal Swing** | Optional switch (`enableSwingH`), only supported by some LG models. |
| **Display Light** | Optional switch (`enableLight`) that toggles the A/C display/LED. |
| **Turbo Mode** | Switch mapped to the `turbo` topic (ignored by the LG IR protocol). |
| **Quiet / Econo / Clean** | Switches mapped to the `quiet`, `econo` and `clean` topics (ignored by the LG IR protocol, useful for other A/C protocols). |
| **Sleep Mode** | Applies a quiet preset (minimum fan, vanes parked at the lowest position and a 28 °C set point). |

### State synchronisation

The plugin subscribes to **all** state topics the sketch publishes
(`<prefix>/ac/stat/+`: `power`, `mode`, `temp`, `fanspeed`, `swingv`, `swingh`,
`turbo`, `quiet`, `econo`, `clean`, `light`, …). Whenever the A/C is changed by the
physical IR remote, by another MQTT client or by the A/C itself, the matching Home app
control is updated:

* the **HeaterCooler** tile follows `power`, `mode`, `temp` and `fanspeed`;
* the **Vertical Swing** switch follows `swingv` (`auto` = on, any parked position = off);
* the **Swing …** position switches highlight the reported `swingv` position;
* **Turbo Mode**, **Quiet**, **Econo**, **Clean** and **Display Light** follow `turbo`,
  `quiet`, `econo`, `clean` and `light`;
* the **Sleep Mode** switch follows the real A/C state — it is only "on" while the A/C still
  matches the preset (28 °C, minimum fan, vanes at `lowest`). Change the temperature, fan or
  swing from the remote and the switch turns itself off.

> **Note:** the LG IR protocol has no native sleep timer, so if you want the A/C to turn
> itself off during the night, set `sleepMinutes` (e.g. `480` for 8 hours). The default is
> `0`, which disables the auto-off entirely.

> **Note:** the LG IR protocol supports only power, mode, temperature, fan, vertical/horizontal
> swing and the display light. The `turbo`, `quiet`, `econo` and `clean` topics are accepted and
> echoed by the sketch (and are functional for other A/C protocols), but the ESP sends no
> effective IR command for them on LG. Hide them with the matching `enable…` flags if you
> don't want them.

### Configuration


```
 "platforms": [
    ...
    {
    "name": "homebridge-irremoteesp8266-mqtt",
    "platform": "ESP8266 IR MQTT",
    "serviceType": "HeaterCooler",
    "devices": [
        {
            "name": "<Any>",
            "displayName": "<Any>",
            "UniqueId": "<Any>",
            "mqtt": {
                "server": "<MQTT Server:1883>",
                "prefix": "<prefix for accessory>",
                "username": "<username>",
                "password": "<password>"
            }
        },
        {
            "name": "<Any>",
            "displayName": "<Any>",
            "UniqueId": "<Any>",
            "sleepMinutes": 0,
            "enableSwingH": false,
            "enableLight": false,
            "enableQuiet": true,
            "enableEcono": true,
            "enableClean": true,
            "enableSwingPosition": true,
            "mqtt": {
                "server": "<MQTT Server:1883>",
                "prefix": "<prefix for accessory>",
                "username": "<username>",
                "password": "<password>"
            }
        }
    ]
}
```

#### Device options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sleepMinutes` | integer | `0` | Set to `0` to never turn the A/C off automatically. When > 0, the A/C is turned off that many minutes after **Sleep Mode** is switched on. |
| `enableSwingH` | boolean | `false` | Expose the optional **Horizontal Swing** switch (LG models using the AKB73757604 remote). |
| `enableLight` | boolean | `false` | Expose the optional **Display Light** switch. |
| `enableQuiet` | boolean | `true` | Expose the **Quiet** switch (LG ignores this setting). |
| `enableEcono` | boolean | `true` | Expose the **Econo** switch (LG ignores this setting). |
| `enableClean` | boolean | `true` | Expose the **Clean** switch (LG ignores this setting). |
| `enableSwingPosition` | boolean | `true` | Expose the **Swing Lowest / Low / Middle / High / Highest** position switches. |
