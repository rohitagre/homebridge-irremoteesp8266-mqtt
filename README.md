<span align="center">

# Homebridge Companion plugin for IRremoteESP8266

</span>

This plugin provides homebridge support form [IRremoteESP8266 library](https://github.com/crankyoldgit/IRremoteESP8266)

To use your IRremote over MQTT and to homebridge using this plugin, you must have [This Arduino Sketch](https://github.com/crankyoldgit/IRremoteESP8266/blob/master/examples/IRMQTTServer/IRMQTTServer.ino) flashed to your ESP8266 device.

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
