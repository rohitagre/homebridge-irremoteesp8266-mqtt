<span align="center">

# Homebridge Companion plugin for IRremoteESP8266

</span>

This plugin provides homebridge support form [IRremoteESP8266 library](https://github.com/crankyoldgit/IRremoteESP8266)

To use your IRremote over MQTT and to homebridge using this plugin, you must have [This Arduino Sketch](https://github.com/crankyoldgit/IRremoteESP8266/blob/master/examples/IRMQTTServer/IRMQTTServer.ino) flashed to your ESP8266 device.

### Features

The accessory is exposed as a HomeKit **HeaterCooler** plus a **swing slider** and a few
optional helper switches:

| Control | Description |
| --- | --- |
| Power / Mode / Temperature / Fan | Standard HeaterCooler controls mapped to `power`, `mode`, `temp` and `fanspeed`. |
| **Swing** *(slider)* | One slider that covers every `swingv` value: `0 %` parks the vanes `off`, `17 % lowest`, `33 % low`, `50 % middle`, `67 % high`, `83 % highest` and `100 %` is `auto` (continuous swing). Published as a `Fan` accessory because that is the only HomeKit service the Home app renders as a slider. |
| **Horizontal Swing** | Optional switch (`enableSwingH`), only supported by some LG models. |
| **Display Light** | Optional switch (`enableLight`) that toggles the A/C display/LED. |
| **Turbo Mode** | Switch mapped to the `turbo` topic (ignored by the LG IR protocol). A transient boost: changing the temperature, fan speed or swing cancels it again. |
| **Quiet / Econo / Clean** | Switches mapped to the `quiet`, `econo` and `clean` topics (ignored by the LG IR protocol, useful for other A/C protocols). |
| **Sleep Mode** | Applies a quiet preset (minimum fan, vanes parked at the lowest position and a 28 °C set point). |

The vertical swing can be laid out in three different ways with `swingControl`:

* `"slider"` (default) – the single **Swing** slider described above;
* `"switch"` – the classic layout: a **Vertical Swing** switch (`auto` vs `off`)
  plus one mutually-exclusive switch per vane position (**Swing Lowest / Low /
  Middle / High / Highest**);
* `"picker"` – a single **Swing** accessory rendered as a chooser (list) of
  `Off / Lowest / Low / Middle / High / Highest / Auto`. This is implemented with
  a HomeKit `Television` service and one input source per vane position, which is
  the closest the Home app gets to a dropdown.

> **Note:** the A/C has a single set point, so the plugin mirrors it onto *both* HeaterCooler
> threshold characteristics (`CoolingThresholdTemperature` and `HeatingThresholdTemperature`,
> 15–30 °C) and onto `CurrentTemperature`. HomeKit renders the `auto` target state as a
> heating/cooling range and hides the temperature slider completely when only one of the two
> exists. The sketch cannot report the room temperature, so both temperature values on the tile
> show the target temperature (the same behaviour as 1.0.8). Out-of-range values reported by
> the sketch are clamped, since HomeKit drops the slider for those as well.

Every control is published as **its own accessory**, so the Home app shows its own name
(e.g. `Swing Low`) instead of repeating the name of the A/C accessory.
**Every control is optional** – see [Choosing which controls to expose](#choosing-which-controls-to-expose)
to keep the number of accessories down. Use `switchNamePrefix` to group them,
e.g. `"LG AC Swing"`.

### State synchronisation

The plugin subscribes to **all** state topics the sketch publishes
(`<prefix>/ac/stat/+`: `power`, `mode`, `temp`, `fanspeed`, `swingv`, `swingh`,
`turbo`, `quiet`, `econo`, `clean`, `light`, …). Whenever the A/C is changed by the
physical IR remote, by another MQTT client or by the A/C itself, the matching Home app
control is updated:

* the **HeaterCooler** tile follows `power`, `mode`, `temp` and `fanspeed`;
* the **Swing** slider follows `swingv` and snaps to the matching level (with
  `swingControl: "switch"`, the **Vertical Swing** switch follows `swingv` –
  `auto` = on, any parked position = off – and the **Swing …** position switches
  highlight the reported position; with `swingControl: "picker"`, the **Swing**
  chooser highlights the matching entry);
* **Quiet**, **Econo**, **Clean** and **Display Light** follow `quiet`, `econo`,
  `clean` and `light`;
* the **Sleep Mode** switch follows the real A/C state — it is only "on" while the A/C still
  matches the preset (28 °C, minimum fan, vanes at `lowest`). Change the temperature, fan or
  swing from the remote *or from the Home app* and the switch turns itself off;
* the **Turbo Mode** switch behaves like a transient boost — it is only "on" while the set
  point, fan speed and vane position still match the settings it was switched on with. Change
  the temperature, fan speed or swing from the remote *or from the Home app* and the switch
  turns itself off again (and `turbo=off` is published, so other clients stay in sync).

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
            "switchNamePrefix": "",
            "swingControl": "slider",
            "enableSwingV": true,
            "enableSwingH": false,
            "enableLight": false,
            "enableQuiet": true,
            "enableEcono": true,
            "enableClean": true,
            "enableSwingPosition": true,
            "enableTurbo": true,
            "enableSleep": true,
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
| `switchNamePrefix` | string | `""` | Prefix added to the name of every control accessory, e.g. `"LG AC "` results in `LG AC Swing`. Handy when several A/C units are configured. Existing accessories are renamed on the next restart. |
| `swingControl` | `"slider"` \| `"switch"` \| `"picker"` | `"slider"` | How the vertical swing is exposed: a single **Swing** slider (`slider`), the classic **Vertical Swing** + per-position switches (`switch`), or a single **Swing** chooser listing every position (`picker`). |
| `enableSwingV` | boolean | `true` | Expose the vertical swing control (the **Swing** slider, the **Vertical Swing** switch with `swingControl: "switch"`, or the **Swing** chooser with `swingControl: "picker"`). |
| `enableSwingH` | boolean | `false` | Expose the **Horizontal Swing** switch (LG models using the AKB73757604 remote). |
| `enableLight` | boolean | `false` | Expose the **Display Light** switch. |
| `enableQuiet` | boolean | `true` | Expose the **Quiet** switch (LG ignores this setting). |
| `enableEcono` | boolean | `true` | Expose the **Econo** switch (LG ignores this setting). |
| `enableClean` | boolean | `true` | Expose the **Clean** switch (LG ignores this setting). |
| `enableSwingPosition` | boolean | `true` | Expose the **Swing Lowest / Low / Middle / High / Highest** position switches (`swingControl: "switch"` only). |
| `enableTurbo` | boolean | `true` | Expose the **Turbo Mode** switch (LG ignores this setting). |
| `enableSleep` | boolean | `true` | Expose the **Sleep Mode** switch. |

#### Choosing which controls to expose

All controls are optional and fall back to the defaults above, so an existing
`config.json` keeps working unchanged. With the defaults, an A/C publishes six extra
accessories (**Swing**, **Quiet**, **Econo**, **Clean**, **Turbo Mode** and **Sleep
Mode**) next to the `LG AC` accessory that holds power, mode, temperature and fan.

The LG IR protocol only really supports power, mode, temperature, fan, vertical and
horizontal swing and the display light, so for an LG unit `Quiet`, `Econo`, `Clean` and
`Turbo` change nothing on the A/C. Turning those off leaves a compact setup – an A/C tile
plus a swing slider and the sleep preset:

```json
"devices": [
    {
        "name": "AC",
        "displayName": "LG AC",
        "UniqueId": "ac-1",
        "switchNamePrefix": "LG AC ",
        "swingControl": "slider",
        "enableQuiet": false,
        "enableEcono": false,
        "enableClean": false,
        "enableTurbo": false,
        "mqtt": {
            "server": "<MQTT Server:1883>",
            "prefix": "<prefix for accessory>"
        }
    }
]
```

That publishes only two extra accessories: `LG AC Swing` (slider) and `LG AC Sleep Mode`.
With every `enable…` option set to `false` you get a single `LG AC` accessory and no extra
tiles – note that the **Sleep Mode** preset (and with it `sleepMinutes`) can then no longer
be switched on from HomeKit.


#### Upgrading from 1.0.9-beta.1 or older

The controls used to be extra services of the A/C accessory, which made the Home app
label every one of them with the name of the A/C (e.g. `LG AC`). They are now published as
separate accessories: the stale services are removed from the cached A/C accessory
automatically on the first start, and the controls reappear as individual tiles with their
own name. Room assignments and automations for those tiles have to be recreated once.

The vertical swing is now a single **Swing** slider by default, so the `Vertical Swing`
switch and the five `Swing …` position switches are replaced by one accessory. Set
`"swingControl": "switch"` to keep the previous layout instead, or
`"swingControl": "picker"` for a single **Swing** chooser that lists `Off / Lowest / Low /
Middle / High / Highest / Auto`.

