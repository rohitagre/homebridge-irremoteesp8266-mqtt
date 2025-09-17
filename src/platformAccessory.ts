import type { CharacteristicValue, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import * as mqtt from "mqtt";
import * as fs from "fs";
import packageJson from '../package.json'  with { type: "json" };
import type { IRMQTTHomebridgePlatform } from './platform.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */

export class IRMQTTPlatformAccessory {
  private service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */


  private mqttClient: mqtt.MqttClient;

  mqttTopic: {
    power: string;
    mode: string;
    temp: string;
    fanspeed: string;
    swingv: string;
    light: string;
    powerstat: string;
    modestat: string;
    tempstat: string;
    fanspeedstat: string;
    swingstat: string;
    lightstat: string;
  };
  mqttPrefix: string;
  acstate: {
    On: boolean;
    Mode: number; // 0: Off, 1: Heat, 2: Cool, 3: Auto, 4: Fan
    TargetMode: number;
    TargetTemp: number;
    DefaultTemp: number;
    rotationSpeed: number;
    CurrentTemp: number;
    Swing: boolean;
  };

  constructor(
    private readonly platform: IRMQTTHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'AC')
      .setCharacteristic(this.platform.Characteristic.Model, 'IRMQTT-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, packageJson.version);


    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) || this.accessory.addService(this.platform.Service.HeaterCooler);


    // set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));


    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.handleCurrentHeaterCoolerStateGet.bind(this))
      .onSet(this.handleCurrentHeaterCoolerStateSet.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE,
          this.platform.Characteristic.CurrentHeaterCoolerState.IDLE,
          this.platform.Characteristic.CurrentHeaterCoolerState.COOLING,
        ],
      });

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.handleTargetHeaterCoolerStateGet.bind(this))
      .onSet(this.handleTargetHeaterCoolerStateSet.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeaterCoolerState.COOL,
        ],
      });


    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.handleRotationSpeedGet.bind(this))
      .onSet(this.handleRotationSpeedSet.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      });

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onGet(this.handleCoolingThresholdTemperatureGet.bind(this))
      .onSet(this.handleCoolingThresholdTemperatureSet.bind(this))
      .setProps({
        minValue: 17,
        maxValue: 30,
        minStep: 1,
      });

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.handleSwingModeGet.bind(this))
      .onSet(this.handleSwingModeSet.bind(this));

    this.acstate = {
      On: false,
      Mode: 3, // 0: Off, 1: Heat, 2: Cool, 3: Auto, 4: Fan
      TargetMode: 2,
      TargetTemp: 22,
      DefaultTemp: 24,
      rotationSpeed: 1,
      CurrentTemp: 22,
      Swing: false, // 0: Off, 1: On
    };
    this.mqttPrefix = accessory.context.device.mqtt.prefix;

    this.mqttTopic = {
      power: this.mqttPrefix + "/ac/cmnd/power",
      mode: this.mqttPrefix + "/ac/cmnd/mode",
      temp: this.mqttPrefix + "/ac/cmnd/temp",
      fanspeed: this.mqttPrefix + "/ac/cmnd/fanspeed",
      swingv: this.mqttPrefix + "/ac/cmnd/swingv",
      light: this.mqttPrefix + "/ac/cmnd/light",
      powerstat: this.mqttPrefix + "/ac/stat/power",
      modestat: this.mqttPrefix + "/ac/stat/mode",
      tempstat: this.mqttPrefix + "/ac/stat/temp",
      fanspeedstat: this.mqttPrefix + "/ac/stat/fanspeed",
      swingstat: this.mqttPrefix + "/ac/stat/swingv",
      lightstat: this.mqttPrefix + "/ac/stat/light",
    };
    this.platform.log.info(`Using MQTT prefix: '${this.mqttPrefix}'`);

    this.platform.log.debug(JSON.stringify(this.mqttTopic));

    this.mqttClient = this.mqttInit(accessory);

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  private async setActive(value: CharacteristicValue) {
    this.acstate.On = value as boolean;
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic On ->', value);


    if (value === this.platform.Characteristic.Active.INACTIVE) {
      this.publishMessage(this.mqttTopic.power, "off");
      this.publishMessage(this.mqttTopic.swingv, "off");
      this.acstate.On = this.platform.Characteristic.Active.INACTIVE as unknown as boolean;
      this.acstate.Mode = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    } else {
      if ((this.acstate.Mode === this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE)) {
        this.acstate.Mode = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
        this.acstate.TargetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
      }
      this.publishMessage(this.mqttTopic.power, "on");
      this.publishMessage(this.mqttTopic.mode, this.acstate.Mode === this.platform.Characteristic.CurrentHeaterCoolerState.COOLING ? "cool" : "auto");
      this.acstate.TargetTemp = this.acstate.CurrentTemp = this.acstate.DefaultTemp as number;

    }
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   */
  private async getActive(): Promise<CharacteristicValue> {
    const isOn = this.acstate.On;
    this.platform.log.debug(this.accessory.displayName, 'Get Characteristic On -> ', isOn);
    return isOn;
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   */
  private async handleCurrentHeaterCoolerStateGet() {
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic CurrentHeaterCoolerState -> ', this.acstate.Mode);
    return this.acstate.Mode;
  }
  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Mode
   */
  private async handleCurrentHeaterCoolerStateSet() {
    this.publishMessage(this.mqttTopic.mode, this.acstate.Mode === this.platform.Characteristic.CurrentHeaterCoolerState.COOLING ? "cool" : "auto");
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic CurrentHeaterCoolerState -> ', this.acstate.Mode);

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Mode
   */
  private async handleTargetHeaterCoolerStateSet(value: CharacteristicValue) {

    if (value === this.platform.Characteristic.TargetHeaterCoolerState.AUTO) {
      this.publishMessage(this.mqttTopic.mode, "auto");
    } else if (value === this.platform.Characteristic.TargetHeaterCoolerState.COOL) {
      this.publishMessage(this.mqttTopic.mode, "cool");
    }

    this.acstate.Mode = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
    this.acstate.TargetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic TargetHeaterCoolerState -> ', this.acstate.TargetMode);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   */
  private async handleTargetHeaterCoolerStateGet() {
    this.platform.log.debug(this.accessory.displayName, 'Get Characteristic TargetHeaterCoolerState -> ', this.acstate.TargetMode);

    return this.acstate.TargetMode;
  }
  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Mode
   */
  private async handleCurrentTemperatureGet() {
    this.platform.log.debug(this.accessory.displayName, 'Get Characteristic CurrentTemperature -> ', this.acstate.TargetTemp);

    return this.acstate.TargetTemp;
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   */
  private async handleCoolingThresholdTemperatureGet() {
    this.platform.log.debug(this.accessory.displayName, 'Get Characteristic TargetTemp -> ', this.acstate.TargetTemp);
    return this.acstate.TargetTemp;
  }

  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  private async handleCoolingThresholdTemperatureSet(value: CharacteristicValue) {
    this.acstate.TargetTemp = this.acstate.CurrentTemp = value as number;
    this.publishMessage(this.mqttTopic.temp, this.acstate.TargetTemp.toString());
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic TargetTemp -> ', this.acstate.TargetTemp);

  }
  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  private async handleRotationSpeedGet() {
    this.platform.log.debug(this.accessory.displayName, 'Get Characteristic rotationSpeed -> ', this.acstate.rotationSpeed);
    return this.acstate.rotationSpeed;
  }

  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  private async handleRotationSpeedSet(value: CharacteristicValue) {
    const numericValue = typeof value === 'number' ? value : Number(value);
    let fanspeed = "auto";
    if (numericValue <= 100 && numericValue >= 75) {
      fanspeed = "max";
    } else if (numericValue < 75 && numericValue >= 50) {
      fanspeed = "medium";
    } else if (numericValue < 50 && numericValue >= 25) {
      fanspeed = "min";
    }
    this.publishMessage(this.mqttTopic.fanspeed, fanspeed);
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic Mode -> ', numericValue);

  }


  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   */
  private async handleSwingModeGet() {
    this.platform.log.debug(this.accessory.displayName, 'Get Characteristic Swing -> ', this.acstate.Swing);
    return this.acstate.Swing;
  }

  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  private async handleSwingModeSet(value: CharacteristicValue) {
    this.acstate.Swing = value as boolean;
    this.publishMessage(this.mqttTopic.swingv, this.acstate.Swing ? "auto" : "off");
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic Swing -> ', this.acstate.Swing);
  }

  private mqttInit(accessory: PlatformAccessory, closed: boolean = false) {
    if (this.isConnected() && !closed) {
      this.platform.log.debug('Already connected to MQTT broker, skipping connection.');
      return this.mqttClient;
    }

    this.platform.log.debug('Connecting to MQTT broker', accessory.context.device.mqtt.server);

    const options: mqtt.IClientOptions = IRMQTTPlatformAccessory.createMqttOptions(this.platform.log, accessory.context.device);

    const mqttClient: mqtt.MqttClient = mqtt.connect("mqtt://" + accessory.context.device.mqtt.server, options);

    mqttClient.on('connect', this.onMqttConnected.bind(this));
    mqttClient.on('close', this.onMqttClose.bind(this));

    mqttClient.on('message', (topic: string, message: Buffer) => this.onMessage(topic, message.toString()));
    mqttClient.subscribe(this.mqttPrefix + '/#');
    return mqttClient;
  }

  private isConnected(): boolean {
    return this.mqttClient !== undefined;
  }
  private async publishMessage(topic: string, payload: string) {
    if (this.accessory.context.device !== undefined) {
      topic = `${topic}`;
      const options: mqtt.IClientPublishOptions = { qos: 2, retain: true };
      if (!this.isConnected) {
        this.platform.log.error('Not connected to MQTT server!');
        this.platform.log.error(`Cannot send message to '${topic}': '${payload}`);
        return;
      }

      this.platform.log.debug(`Publish to '${topic}': '${payload}'`);

      return new Promise<void>((resolve) => {
        this.mqttClient?.publish(topic, payload, options, () => resolve());
      });
    }
  }

  private static createMqttOptions(log: Logging, config: PlatformConfig): mqtt.IClientOptions {
    const options: mqtt.IClientOptions = {};
    if (config.mqtt.version) {
      options.protocolVersion = config.mqtt.version;
    }

    if (config.mqtt.keepalive) {
      log.debug(`Using MQTT keepalive: ${config.mqtt.keepalive}`);
      options.keepalive = config.mqtt.keepalive;
    }

    if (config.mqtt.ca) {
      log.debug(`MQTT SSL/TLS: Path to CA certificate = ${config.mqtt.ca}`);
      options.ca = fs.readFileSync(config.mqtt.ca);
    }

    if (config.mqtt.key && config.mqtt.cert) {
      log.debug(`MQTT SSL/TLS: Path to client key = ${config.mqtt.key}`);
      log.debug(`MQTT SSL/TLS: Path to client certificate = ${config.mqtt.cert}`);
      options.key = fs.readFileSync(config.mqtt.key);
      options.cert = fs.readFileSync(config.mqtt.cert);
    }

    if (config.mqtt.username && config.mqtt.password) {
      options.username = config.mqtt.username;
      options.password = config.mqtt.password;
    }

    if (config.mqtt.client_id) {
      log.debug(`Using MQTT client ID: '${config.mqtt.client_id}'`);
      options.clientId = config.mqtt.client_id;
    }

    if (config.mqtt.reject_unauthorized !== undefined && !config.mqtt.reject_unauthorized) {
      log.debug('MQTT reject_unauthorized set false, ignoring certificate warnings.');
      options.rejectUnauthorized = false;
    }

    return options;
  }

  private onMqttConnected(): void {
    this.platform.log.info('Connected to MQTT server');
  }

  private onMqttClose(): void {
    this.platform.log.error('Disconnected from MQTT server!');
  }
  private onMessage(topic: string, message: string) {
    const fullTopic = topic;
    message = message.toLowerCase();
    this.platform.log.debug(`Received MQTT message on '${fullTopic}': ${message}`);
    try {
      const baseTopic = `${this.mqttPrefix}/`;
      if (!topic.startsWith(baseTopic)) {
        this.platform.log.debug('Ignore message, because topic is unexpected.', topic);
        return;
      }

      if (topic === this.mqttTopic.powerstat) {
        const value = message === "on" ? true : false;
        this.platform.log.debug(`Received power state update: ${value}`);
        this.acstate.On = value;
      } else if (topic === this.mqttTopic.tempstat) {
        const value = parseInt(message);
        this.acstate.TargetTemp = this.acstate.CurrentTemp = value;
      } else if (topic === this.mqttTopic.swingstat) {
        const value = message === "auto" ? true : false;
        this.acstate.Swing = value;
      } else if (topic === this.mqttTopic.fanspeedstat) {
        const value = message;
        let fanspeed = 100;
        if (value === "auto") {
          fanspeed = 100;
        } else if (value === "min") {
          fanspeed = 25;
        } else if (value === "medium") {
          fanspeed = 50;
        } else if (value === "max") {
          fanspeed = 75;
        }
        this.acstate.rotationSpeed = fanspeed;
      } else if (topic === this.mqttTopic.modestat) {
        const value = message;
        let mode: CharacteristicValue = 3,
          TargetMode: CharacteristicValue = 2;
        if (value === "auto") {
          mode = this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
        } else if (value === "cool") {
          mode = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
          TargetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
        } else if (value === "off") {
          mode = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        } else {
          TargetMode = this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
        }
        this.acstate.Mode = mode as number;
        this.acstate.TargetMode = TargetMode as number;
      }

    } catch (err: unknown) {
      this.platform.log.error(`Failed to process MQTT message on '${fullTopic}'. (Maybe check the MQTT version?)`);
      this.platform.log.error(String(err));
    }
  }

}