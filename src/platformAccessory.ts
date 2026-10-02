import type { CharacteristicValue, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import * as mqtt from 'mqtt';
import * as fs from 'fs';
import packageJson from '../package.json' with { type: 'json' };
import type { IRMQTTHomebridgePlatform } from './platform.js';

/**
 * Vertical swing positions exposed as individual switches. "Auto" (continuous
 * swing) is handled by the dedicated Vertical Swing switch.
 */
const SWING_POSITIONS: ReadonlyArray<{ position: string; name: string }> = [
  { position: 'lowest', name: 'Swing Lowest' },
  { position: 'low', name: 'Swing Low' },
  { position: 'middle', name: 'Swing Middle' },
  { position: 'high', name: 'Swing High' },
  { position: 'highest', name: 'Swing Highest' },
];

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */

export class IRMQTTPlatformAccessory {
  private service: Service;
  private turboService: Service;
  private sleepService: Service;
  private swingService: Service;
  private swingHService?: Service;
  private lightService?: Service;
  private quietService?: Service;
  private econoService?: Service;
  private cleanService?: Service;
  private readonly swingPositionServices: Array<{ position: string; service: Service }> = [];
  private sleepTimeout: NodeJS.Timeout | null = null;
  private sleepSyncTimeout: NodeJS.Timeout | null = null;
  private readonly sleepMinutes: number;
  private readonly sleepTemp = 28;

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
    swingh: string;
    turbo: string;
    quiet: string;
    econo: string;
    clean: string;
    light: string;
    powerstat: string;
    modestat: string;
    tempstat: string;
    fanspeedstat: string;
    swingstat: string;
    swinghstat: string;
    turbostat: string;
    quietstat: string;
    econostat: string;
    cleanstat: string;
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
    SwingPosition: string; // Last reported swingv value: off / auto / lowest / low / middle / high / highest
    SwingH: boolean;
    Turbo: boolean;
    Quiet: boolean;
    Econo: boolean;
    Clean: boolean;
    Light: boolean;
    LowFanPreset: boolean;
    Sleep: boolean;
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
          this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
          this.platform.Characteristic.TargetHeaterCoolerState.COOL,
        ],
      });


    this.service.addOptionalCharacteristic(this.platform.Characteristic.RotationSpeed);
    this.service.addOptionalCharacteristic(this.platform.Characteristic.SwingMode);

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
        minValue: 15,
        maxValue: 30,
        minStep: 1,
      });

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.handleSwingModeGet.bind(this))
      .onSet(this.handleSwingModeSet.bind(this));

    // Dedicated switch for vertical swing. Several HomeKit clients (the Apple
    // Home app in particular) don't render the optional SwingMode characteristic
    // on a HeaterCooler service, so a switch is the reliable way to control it.
    this.swingService = this.accessory.services.find(service => service.subtype === 'swingv')
      || this.accessory.addService(this.platform.Service.Switch, 'Vertical Swing', 'swingv');
    this.swingService.setCharacteristic(this.platform.Characteristic.Name, 'Vertical Swing');
    this.swingService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.acstate.Swing)
      .onSet(this.handleSwingSwitchSet.bind(this));

    // Horizontal swing is only supported by a subset of LG models (e.g. the
    // AKB73757604 remote), so it is opt-in via the device configuration.
    if (accessory.context.device.enableSwingH === true) {
      this.swingHService = this.accessory.services.find(service => service.subtype === 'swingh')
        || this.accessory.addService(this.platform.Service.Switch, 'Horizontal Swing', 'swingh');
      this.swingHService.setCharacteristic(this.platform.Characteristic.Name, 'Horizontal Swing');
      this.swingHService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.acstate.SwingH)
        .onSet(this.handleSwingHSwitchSet.bind(this));
    }

    // The display light is supported by the LG protocol. Opt-in so existing
    // setups don't suddenly gain an extra switch.
    if (accessory.context.device.enableLight === true) {
      this.lightService = this.accessory.services.find(service => service.subtype === 'light')
        || this.accessory.addService(this.platform.Service.Switch, 'Display Light', 'light');
      this.lightService.setCharacteristic(this.platform.Characteristic.Name, 'Display Light');
      this.lightService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.acstate.Light)
        .onSet(this.handleLightSet.bind(this));
    }

    // Quiet / Econo / Clean. The IRMQTTServer sketch accepts and echoes these
    // topics, but the LG IR protocol itself ignores them (they are useful for
    // other A/C protocols). Enabled by default; set enableQuiet / enableEcono /
    // enableClean to false to hide the switches.
    if (accessory.context.device.enableQuiet !== false) {
      this.quietService = this.accessory.services.find(service => service.subtype === 'quiet')
        || this.accessory.addService(this.platform.Service.Switch, 'Quiet', 'quiet');
      this.quietService.setCharacteristic(this.platform.Characteristic.Name, 'Quiet');
      this.quietService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.acstate.Quiet)
        .onSet(this.handleQuietSet.bind(this));
    }

    if (accessory.context.device.enableEcono !== false) {
      this.econoService = this.accessory.services.find(service => service.subtype === 'econo')
        || this.accessory.addService(this.platform.Service.Switch, 'Econo', 'econo');
      this.econoService.setCharacteristic(this.platform.Characteristic.Name, 'Econo');
      this.econoService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.acstate.Econo)
        .onSet(this.handleEconoSet.bind(this));
    }

    if (accessory.context.device.enableClean !== false) {
      this.cleanService = this.accessory.services.find(service => service.subtype === 'clean')
        || this.accessory.addService(this.platform.Service.Switch, 'Clean', 'clean');
      this.cleanService.setCharacteristic(this.platform.Characteristic.Name, 'Clean');
      this.cleanService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.acstate.Clean)
        .onSet(this.handleCleanSet.bind(this));
    }

    // Vertical swing position selector: one mutually-exclusive switch per fixed
    // louvre position. "Auto" (continuous swing) lives on the Vertical Swing
    // switch. Set enableSwingPosition to false to hide these.
    if (accessory.context.device.enableSwingPosition !== false) {
      for (const { position, name } of SWING_POSITIONS) {
        const subtype = `swingv-${position}`;
        const positionService = this.accessory.services.find(service => service.subtype === subtype)
          || this.accessory.addService(this.platform.Service.Switch, name, subtype);
        positionService.setCharacteristic(this.platform.Characteristic.Name, name);
        positionService.getCharacteristic(this.platform.Characteristic.On)
          .onGet(() => this.acstate.SwingPosition === position)
          .onSet(value => this.handleSwingPositionSet(position, value));
        this.swingPositionServices.push({ position, service: positionService });
      }
    }

    this.turboService = this.accessory.services.find(service => service.subtype === 'turbo')
      || this.accessory.addService(this.platform.Service.Switch, 'Turbo Mode', 'turbo');
    this.turboService.setCharacteristic(this.platform.Characteristic.Name, 'Turbo Mode');
    this.turboService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.acstate.Turbo)
      .onSet(this.handleTurboSet.bind(this));

    // "Sleep Mode" (previously "Low Fan Preset") applies a quiet preset and
    // automatically turns the A/C off after `sleepMinutes` (default 60). The LG
    // IR protocol has no native sleep timer, so the countdown is run by the
    // plugin. The subtype is kept as 'low-fan-preset' so existing cached
    // accessories are reused instead of duplicated.
    this.sleepService = this.accessory.services.find(service => service.subtype === 'low-fan-preset')
      || this.accessory.addService(this.platform.Service.Switch, 'Sleep Mode', 'low-fan-preset');
    this.sleepService.setCharacteristic(this.platform.Characteristic.Name, 'Sleep Mode');
    this.sleepService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.acstate.Sleep)
      .onSet(this.handleSleepModeSet.bind(this));

    this.acstate = {
      On: false,
      Mode: 3, // 0: Off, 1: Heat, 2: Cool, 3: Auto, 4: Fan
      TargetMode: 2,
      TargetTemp: 22,
      DefaultTemp: 24,
      rotationSpeed: 1,
      CurrentTemp: 22,
      Swing: false, // Vertical swing: off / auto
      SwingPosition: "off", // Last reported swingv position
      SwingH: false, // Horizontal swing: off / auto
      Turbo: false,
      Quiet: false,
      Econo: false,
      Clean: false,
      Light: false,
      LowFanPreset: false,
      Sleep: false,
    };
    // Sleep Mode auto-off is opt-in: 0 (the default) means the A/C is never
    // turned off automatically on a timer.
    const configuredSleepMinutes = Number(accessory.context.device.sleepMinutes);
    this.sleepMinutes = Number.isFinite(configuredSleepMinutes) && configuredSleepMinutes > 0
      ? configuredSleepMinutes
      : 0;
    this.mqttPrefix = accessory.context.device.mqtt.prefix;

    this.mqttTopic = {
      power: this.mqttPrefix + "/ac/cmnd/power",
      mode: this.mqttPrefix + "/ac/cmnd/mode",
      temp: this.mqttPrefix + "/ac/cmnd/temp",
      fanspeed: this.mqttPrefix + "/ac/cmnd/fanspeed",
      swingv: this.mqttPrefix + "/ac/cmnd/swingv",
      swingh: this.mqttPrefix + "/ac/cmnd/swingh",
      turbo: this.mqttPrefix + "/ac/cmnd/turbo",
      quiet: this.mqttPrefix + "/ac/cmnd/quiet",
      econo: this.mqttPrefix + "/ac/cmnd/econo",
      clean: this.mqttPrefix + "/ac/cmnd/clean",
      light: this.mqttPrefix + "/ac/cmnd/light",
      powerstat: this.mqttPrefix + "/ac/stat/power",
      modestat: this.mqttPrefix + "/ac/stat/mode",
      tempstat: this.mqttPrefix + "/ac/stat/temp",
      fanspeedstat: this.mqttPrefix + "/ac/stat/fanspeed",
      swingstat: this.mqttPrefix + "/ac/stat/swingv",
      swinghstat: this.mqttPrefix + "/ac/stat/swingh",
      turbostat: this.mqttPrefix + "/ac/stat/turbo",
      quietstat: this.mqttPrefix + "/ac/stat/quiet",
      econostat: this.mqttPrefix + "/ac/stat/econo",
      cleanstat: this.mqttPrefix + "/ac/stat/clean",
      lightstat: this.mqttPrefix + "/ac/stat/light",
    };
    this.platform.log.info(`Using MQTT prefix: '${this.mqttPrefix}'`);

    this.platform.log.debug(JSON.stringify(this.mqttTopic));

    this.mqttClient = this.mqttInit(accessory);

  }

  public shutdown(): void {
    this.clearSleepTimer();
    this.clearSleepSync();
    this.mqttClient?.end();
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  private async setActive(value: CharacteristicValue) {
    this.acstate.On = value === this.platform.Characteristic.Active.ACTIVE;
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic On ->', value);


    if (value === this.platform.Characteristic.Active.INACTIVE) {
      this.publishMessage(this.mqttTopic.power, "off");
      this.acstate.On = false;
      this.acstate.Mode = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
      // Switching the A/C off cancels any running sleep timer.
      this.stopSleepMode();
    } else {
      if ((this.acstate.Mode === this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE)) {
        this.acstate.Mode = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
        this.acstate.TargetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
      }
      this.publishMessage(this.mqttTopic.power, "on");
      this.publishMessage(this.mqttTopic.mode, this.acstate.Mode === this.platform.Characteristic.CurrentHeaterCoolerState.COOLING ? "cool" : "auto");
      // Re-assert the user's vertical swing preference after a power cycle. The
      // A/C remembers its swing state, but re-sending keeps HomeKit in sync.
      if (this.acstate.Swing) {
        this.publishMessage(this.mqttTopic.swingv, "auto");
      }
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

    this.acstate.TargetMode = value as number;
    this.acstate.Mode = value === this.platform.Characteristic.TargetHeaterCoolerState.COOL
      ? this.platform.Characteristic.CurrentHeaterCoolerState.COOLING
      : this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
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
    this.platform.log.debug(this.accessory.displayName, 'Get Characteristic CurrentTemperature -> ', this.acstate.CurrentTemp);

    return this.acstate.CurrentTemp;
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
    this.acstate.rotationSpeed = numericValue;
    this.platform.log.debug(this.accessory.displayName, 'Set Characteristic Mode -> ', numericValue);

  }


  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   */
  private async handleSwingModeGet(): Promise<CharacteristicValue> {
    this.platform.log.debug(this.accessory.displayName, 'Get Characteristic Swing -> ', this.acstate.Swing);
    // SwingMode is an enum (0/1), not a boolean. Returning a boolean can make
    // HomeKit reject the value, which is why swing previously misbehaved.
    return this.acstate.Swing
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  private async handleSwingModeSet(value: CharacteristicValue) {
    await this.setSwingV(value === this.platform.Characteristic.SwingMode.SWING_ENABLED || value === true);
  }

  private async handleSwingSwitchSet(value: CharacteristicValue) {
    await this.setSwingV(value === true);
  }

  /**
   * Keep the SwingMode characteristic, the Vertical Swing switch and every
   * swing-position switch in sync with the reported A/C state.
   */
  private syncSwingCharacteristics(): void {
    const swinging = this.acstate.Swing;
    this.service.updateCharacteristic(this.platform.Characteristic.SwingMode,
      swinging ? this.platform.Characteristic.SwingMode.SWING_ENABLED : this.platform.Characteristic.SwingMode.SWING_DISABLED);
    this.swingService.updateCharacteristic(this.platform.Characteristic.On, swinging);
    for (const { position, service } of this.swingPositionServices) {
      service.updateCharacteristic(this.platform.Characteristic.On, this.acstate.SwingPosition === position);
    }
  }

  /**
   * Apply the vertical swing state, publish it and refresh every swing related
   * HomeKit control.
   */
  private async setSwingV(on: boolean) {
    this.acstate.Swing = on;
    this.acstate.SwingPosition = on ? "auto" : "off";
    await this.publishMessage(this.mqttTopic.swingv, on ? "auto" : "off");
    this.syncSwingCharacteristics();
    this.platform.log.debug(this.accessory.displayName, 'Set Vertical Swing -> ', on);
  }

  /**
   * Park the louvres at a fixed vertical position (lowest / low / middle /
   * high / highest) or "off".
   */
  private async setSwingPosition(position: string) {
    this.acstate.Swing = false;
    this.acstate.SwingPosition = position;
    await this.publishMessage(this.mqttTopic.swingv, position);
    this.syncSwingCharacteristics();
    this.platform.log.debug(this.accessory.displayName, 'Set Swing Position -> ', position);
  }

  private async handleSwingPositionSet(position: string, value: CharacteristicValue) {
    if (value === true) {
      await this.setSwingPosition(position);
    } else if (this.acstate.SwingPosition === position) {
      // The active position switch was turned off -> park the louvres off.
      await this.setSwingPosition("off");
    }
  }

  private async handleSwingHSwitchSet(value: CharacteristicValue) {
    this.acstate.SwingH = value === true;
    await this.publishMessage(this.mqttTopic.swingh, this.acstate.SwingH ? "auto" : "off");
    this.swingHService?.updateCharacteristic(this.platform.Characteristic.On, this.acstate.SwingH);
    this.platform.log.debug(this.accessory.displayName, 'Set Horizontal Swing -> ', this.acstate.SwingH);
  }

  private async handleLightSet(value: CharacteristicValue) {
    this.acstate.Light = value === true;
    await this.publishMessage(this.mqttTopic.light, this.acstate.Light ? "on" : "off");
    this.lightService?.updateCharacteristic(this.platform.Characteristic.On, this.acstate.Light);
    this.platform.log.debug(this.accessory.displayName, 'Set Display Light -> ', this.acstate.Light);
  }

  private async handleQuietSet(value: CharacteristicValue) {
    this.acstate.Quiet = value === true;
    await this.publishMessage(this.mqttTopic.quiet, this.acstate.Quiet ? "on" : "off");
    this.quietService?.updateCharacteristic(this.platform.Characteristic.On, this.acstate.Quiet);
    this.platform.log.debug(this.accessory.displayName, 'Set Quiet -> ', this.acstate.Quiet);
  }

  private async handleEconoSet(value: CharacteristicValue) {
    this.acstate.Econo = value === true;
    await this.publishMessage(this.mqttTopic.econo, this.acstate.Econo ? "on" : "off");
    this.econoService?.updateCharacteristic(this.platform.Characteristic.On, this.acstate.Econo);
    this.platform.log.debug(this.accessory.displayName, 'Set Econo -> ', this.acstate.Econo);
  }

  private async handleCleanSet(value: CharacteristicValue) {
    this.acstate.Clean = value === true;
    await this.publishMessage(this.mqttTopic.clean, this.acstate.Clean ? "on" : "off");
    this.cleanService?.updateCharacteristic(this.platform.Characteristic.On, this.acstate.Clean);
    this.platform.log.debug(this.accessory.displayName, 'Set Clean -> ', this.acstate.Clean);
  }

  private async handleTurboSet(value: CharacteristicValue) {
    this.acstate.Turbo = value as boolean;
    this.publishMessage(this.mqttTopic.turbo, this.acstate.Turbo ? "on" : "off");
    this.platform.log.debug(this.accessory.displayName, 'Set Turbo Mode -> ', this.acstate.Turbo);
  }

  /**
   * Sleep Mode: applies a quiet preset (minimum fan, vanes parked at the lowest
   * position and a 28 °C set point). When `sleepMinutes` is greater than 0 the
   * A/C is additionally turned off after that many minutes (the LG IR protocol
   * has no native sleep timer, so the countdown is handled by the plugin).
   */
  private async handleSleepModeSet(value: CharacteristicValue) {
    const on = value === true;
    this.clearSleepSync();
    this.acstate.Sleep = on;
    this.acstate.LowFanPreset = on;
    this.clearSleepTimer();
    if (on) {
      await this.publishMessage(this.mqttTopic.fanspeed, "min");
      await this.publishMessage(this.mqttTopic.swingv, "lowest");
      await this.publishMessage(this.mqttTopic.temp, this.sleepTemp.toString());
      this.acstate.rotationSpeed = 25;
      this.acstate.TargetTemp = this.acstate.CurrentTemp = this.sleepTemp;
      // The vanes are parked at the lowest position, so vertical swing is off.
      this.acstate.Swing = false;
      this.acstate.SwingPosition = "lowest";
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 25);
      this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.sleepTemp);
      this.syncSwingCharacteristics();
      this.startSleepTimer();
    } else {
      this.platform.log.info(`${this.accessory.displayName}: Sleep mode cancelled.`);
    }
    // Keep the switch authoritative even when triggered programmatically.
    this.sleepService.updateCharacteristic(this.platform.Characteristic.On, on);
    this.platform.log.debug(this.accessory.displayName, 'Set Sleep Mode -> ', on);
  }

  private startSleepTimer(): void {
    if (!Number.isFinite(this.sleepMinutes) || this.sleepMinutes <= 0) {
      return;
    }
    this.sleepTimeout = setTimeout(() => {
      void this.onSleepTimerExpired();
    }, this.sleepMinutes * 60 * 1000);
    // Don't keep the Node.js process alive just for the sleep timer.
    this.sleepTimeout.unref();
    this.platform.log.info(`${this.accessory.displayName}: Sleep mode will turn the A/C off in ${this.sleepMinutes} minute(s).`);
  }

  private clearSleepTimer(): void {
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout);
      this.sleepTimeout = null;
    }
  }

  /**
   * Debounced re-evaluation of the Sleep Mode switch. Applying the preset makes
   * the A/C echo several `stat` messages, so coalescing them avoids flicker.
   */
  private scheduleSleepSync(): void {
    if (this.sleepSyncTimeout) {
      clearTimeout(this.sleepSyncTimeout);
    }
    this.sleepSyncTimeout = setTimeout(() => {
      this.sleepSyncTimeout = null;
      this.syncSleepSwitch();
    }, 750);
  }

  private clearSleepSync(): void {
    if (this.sleepSyncTimeout) {
      clearTimeout(this.sleepSyncTimeout);
      this.sleepSyncTimeout = null;
    }
  }

  /**
   * Reflect the real A/C state on the Sleep Mode switch: it is "on" only while
   * the A/C still matches the sleep preset (28 °C, minimum fan and the vanes
   * parked at the lowest position). Any change made from the IR remote, the A/C
   * itself or another MQTT client therefore flips the switch in the Home app.
   */
  private syncSleepSwitch(): void {
    const active = this.acstate.TargetTemp === this.sleepTemp
      && this.acstate.rotationSpeed === 25
      && this.acstate.SwingPosition === "lowest";
    if (active !== this.acstate.Sleep) {
      this.acstate.Sleep = active;
      this.acstate.LowFanPreset = active;
      this.sleepService.updateCharacteristic(this.platform.Characteristic.On, active);
      this.platform.log.debug(this.accessory.displayName, 'Sleep Mode synced from A/C state -> ', active);
    }
  }

  /**
   * Cancel an active sleep mode without sending any commands (used when the A/C
   * is switched off by other means, e.g. from the Home app or the IR remote).
   */
  private stopSleepMode(): void {
    this.clearSleepTimer();
    this.clearSleepSync();
    if (this.acstate.Sleep) {
      this.acstate.Sleep = false;
      this.acstate.LowFanPreset = false;
      this.sleepService.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  private async onSleepTimerExpired(): Promise<void> {
    this.sleepTimeout = null;
    this.acstate.Sleep = false;
    this.acstate.LowFanPreset = false;
    this.platform.log.info(`${this.accessory.displayName}: Sleep timer expired, turning the A/C off.`);
    this.sleepService.updateCharacteristic(this.platform.Characteristic.On, false);
    this.acstate.On = false;
    this.acstate.Mode = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.acstate.Mode);
    await this.publishMessage(this.mqttTopic.power, "off");
  }

  private mqttInit(accessory: PlatformAccessory, closed: boolean = false) {
    if (this.isConnected() && !closed) {
      this.platform.log.debug('Already connected to MQTT broker, skipping connection.');
      return this.mqttClient;
    }

    this.platform.log.debug('Connecting to MQTT broker', accessory.context.device.mqtt.server);

    const options: mqtt.IClientOptions = IRMQTTPlatformAccessory.createMqttOptions(this.platform.log, accessory.context.device);

    const protocol = accessory.context.device.mqtt.tls ? "mqtts://" : "mqtt://";
    const mqttClient: mqtt.MqttClient = mqtt.connect(protocol + accessory.context.device.mqtt.server, options);

    mqttClient.on('connect', this.onMqttConnected.bind(this));
    mqttClient.on('close', this.onMqttClose.bind(this));
    mqttClient.on('error', this.onMqttError.bind(this));
    mqttClient.on('offline', () => this.platform.log.warn('MQTT client is offline'));
    mqttClient.on('reconnect', () => this.platform.log.info('Reconnecting to MQTT server'));

    mqttClient.on('message', (topic: string, message: Buffer) => this.onMessage(topic, message.toString()));
    mqttClient.subscribe(this.mqttPrefix + '/#');
    return mqttClient;
  }

  private isConnected(): boolean {
    return this.mqttClient?.connected === true;
  }
  private async publishMessage(topic: string, payload: string) {
    if (this.accessory.context.device !== undefined) {
      topic = `${topic}`;
      const options: mqtt.IClientPublishOptions = { qos: 2, retain: true };
      if (!this.isConnected()) {
        this.platform.log.warn('Not connected to MQTT server; command not sent.');
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
    const options: mqtt.IClientOptions = {
      // Send MQTT PINGREQ packets regularly and keep retrying after a
      // temporary broker or network failure. mqtt.connect() otherwise uses
      // the library defaults, which can be changed by a dependency upgrade.
      keepalive: config.mqtt.keepalive ?? 60,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
    };
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
    this.platform.log.info('Connected to MQTT server', this.accessory.context.device.mqtt.server, this.accessory.context.device.mqtt.prefix);
  }

  private onMqttClose(): void {
    this.platform.log.warn('Disconnected from MQTT server');
  }

  private onMqttError(error: Error): void {
    this.platform.log.error(`MQTT error: ${error.message}`);
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
        if (!value) {
          // The A/C was switched off (possibly by the IR remote), so any running
          // sleep timer is no longer relevant.
          this.stopSleepMode();
        }
        this.service.updateCharacteristic(this.platform.Characteristic.Active,
          value ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
      } else if (topic === this.mqttTopic.tempstat) {
        const value = Number(message);
        if (!Number.isFinite(value)) {
          throw new Error(`Invalid temperature payload: ${message}`);
        }
        this.acstate.TargetTemp = this.acstate.CurrentTemp = value;
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, value);
        this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, value);
        this.scheduleSleepSync();
      } else if (topic === this.mqttTopic.swingstat) {
        // Only "auto" (continuous swing) means swing is on. Discrete vane
        // positions such as "lowest" park the louvres, so swing is off.
        this.acstate.SwingPosition = message;
        this.acstate.Swing = message === "auto" || message === "swing" || message === "1";
        this.syncSwingCharacteristics();
        this.scheduleSleepSync();
      } else if (topic === this.mqttTopic.swinghstat) {
        const value = message !== "off" && message !== "0";
        this.acstate.SwingH = value;
        this.swingHService?.updateCharacteristic(this.platform.Characteristic.On, value);
      } else if (topic === this.mqttTopic.turbostat) {
        const value = message === "on";
        this.acstate.Turbo = value;
        this.turboService.updateCharacteristic(this.platform.Characteristic.On, value);
      } else if (topic === this.mqttTopic.lightstat) {
        const value = message === "on";
        this.acstate.Light = value;
        this.lightService?.updateCharacteristic(this.platform.Characteristic.On, value);
      } else if (topic === this.mqttTopic.quietstat) {
        const value = message === "on";
        this.acstate.Quiet = value;
        this.quietService?.updateCharacteristic(this.platform.Characteristic.On, value);
      } else if (topic === this.mqttTopic.econostat) {
        const value = message === "on";
        this.acstate.Econo = value;
        this.econoService?.updateCharacteristic(this.platform.Characteristic.On, value);
      } else if (topic === this.mqttTopic.cleanstat) {
        const value = message === "on";
        this.acstate.Clean = value;
        this.cleanService?.updateCharacteristic(this.platform.Characteristic.On, value);
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
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, fanspeed);
        this.scheduleSleepSync();
      } else if (topic === this.mqttTopic.modestat) {
        const value = message;
        // Note: CurrentHeaterCoolerState and TargetHeaterCoolerState use
        // different numeric values, so they must not be mixed up here.
        let mode: CharacteristicValue = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
        let targetMode: CharacteristicValue = this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
        if (value === "cool") {
          mode = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
          targetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
        } else if (value === "off") {
          mode = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        // "auto", "heat", "dry" and "fan" all map to the AUTO target mode.
        this.acstate.Mode = mode as number;
        this.acstate.TargetMode = targetMode as number;
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.acstate.Mode);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.acstate.TargetMode);
      }

    } catch (err: unknown) {
      this.platform.log.error(`Failed to process MQTT message on '${fullTopic}'. (Maybe check the MQTT version?)`);
      this.platform.log.error(String(err));
    }
  }

}
