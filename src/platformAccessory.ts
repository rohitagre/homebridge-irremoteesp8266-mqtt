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
 * Prefix used for the subtype of the fixed vane position switches, e.g.
 * `swingv-lowest`. Used both as the accessory cache key and as the subtype of
 * the switch accessory (see `switchAccessory.ts`).
 */
const SWING_POSITION_SUBTYPE_PREFIX = 'swingv-';

/**
 * Temperature range the LG protocol accepts and the HeaterCooler exposes. Values
 * outside this range make the Home app drop the temperature slider entirely.
 */
const MIN_TEMP = 15;
const MAX_TEMP = 30;

/** Set point used until the A/C reports its own temperature. */
const INITIAL_TEMP = 22;

/**
 * Subtype (and accessory cache key) of the swing slider accessory that
 * `swingAccessory.ts` publishes.
 */
const SWING_SLIDER_SUBTYPE = 'swing-slider';

/**
 * How the vertical swing is exposed to HomeKit:
 *
 * * `slider` (default) – one `Fan` accessory whose `RotationSpeed` is rendered
 *   as a slider by the Home app.
 * * `switch` – the classic `Vertical Swing` switch plus one switch per fixed
 *   vane position.
 * * `picker` – one accessory rendered as a chooser: its `Television` service
 *   carries one linked `InputSource` per vane position (`Off` … `Auto`), so the
 *   list can be picked from directly (see `swingPickerAccessory.ts`).
 */
export type SwingControl = 'slider' | 'switch' | 'picker';

/**
 * The vertical swing values exposed by the picker accessory (`swingControl:
 * "picker"`). The numeric `id` is stable and used both as the Television
 * `ActiveIdentifier` and as the `Identifier` of the matching `InputSource`.
 */
export interface SwingPickerOption {
  id: number;
  swingv: string;
  name: string;
}

const SWING_PICKER_OPTIONS: ReadonlyArray<SwingPickerOption> = [
  { id: 1, swingv: 'off', name: 'Off' },
  { id: 2, swingv: 'lowest', name: 'Lowest' },
  { id: 3, swingv: 'low', name: 'Low' },
  { id: 4, swingv: 'middle', name: 'Middle' },
  { id: 5, swingv: 'high', name: 'High' },
  { id: 6, swingv: 'highest', name: 'Highest' },
  { id: 7, swingv: 'auto', name: 'Auto' },
];

/**
 * Subtype (and accessory cache key) of the swing picker accessory that
 * `swingPickerAccessory.ts` publishes.
 */
const SWING_PICKER_SUBTYPE = 'swing-picker';

/**
 * The `swingv` values mapped onto the slider of the swing accessory. The order
 * follows the vane angle: parked off at 0 %, the discrete positions in between
 * and continuous swing (auto) at 100 %.
 */
const SWING_SLIDER_STOPS: ReadonlyArray<{ value: number; swingv: string }> = [
  { value: 0, swingv: 'off' },
  { value: 17, swingv: 'lowest' },
  { value: 33, swingv: 'low' },
  { value: 50, swingv: 'middle' },
  { value: 67, swingv: 'high' },
  { value: 83, swingv: 'highest' },
  { value: 100, swingv: 'auto' },
];

/**
 * A helper switch that is published as a separate accessory. `subtype` is a
 * stable identifier (`swingv`, `light`, `turbo`, `swingv-lowest`, …) and `name`
 * is the label shown in the Home app.
 */
export interface SwitchDefinition {
  subtype: string;
  name: string;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */

export class IRMQTTPlatformAccessory {
  private service: Service;
  /**
   * The helper switches (vertical/horizontal swing, display light, quiet,
   * econo, clean, turbo, sleep mode and the fixed vane positions) are published
   * as their own accessories - see `switchAccessory.ts`. Only the HomeKit
   * `Service` objects are tracked here, so that A/C state changes can be pushed
   * to them.
   */
  private readonly switchServices = new Map<string, Service>();
  /** The `Fan` service of the swing slider accessory (see `swingAccessory.ts`). */
  private swingSliderService?: Service;
  /** The `Television` service of the swing picker accessory (see `swingPickerAccessory.ts`). */
  private swingPickerService?: Service;
  private readonly swingControl: SwingControl;
  private sleepTimeout: NodeJS.Timeout | null = null;
  private sleepSyncTimeout: NodeJS.Timeout | null = null;
  private readonly sleepMinutes: number;
  private readonly sleepTemp = 28;
  /**
   * Turbo is a transient "boost" mode: it is only considered active while the
   * A/C still matches the settings it was switched on with. Any change to the
   * set point, fan speed or vane position (from the Home app, the IR remote or
   * another MQTT client) turns the Turbo switch off again - the snapshot taken
   * when turbo was enabled is what the current state is compared against.
   */
  private turboSyncTimeout: NodeJS.Timeout | null = null;
  private turboBaseline: { temp: number; rotationSpeed: number; swingv: string } | null = null;
  /** When turbo was switched on, used to absorb the following `stat` burst. */
  private turboEnabledAt = 0;

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

    // The HAP defaults of the threshold characteristics (10 °C for cooling and
    // 0 °C for heating) are below the supported range, so seed them with the
    // initial set point first; otherwise HAP reports an "illegal value" warning
    // for each of them when the range is applied.
    this.service.setCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, INITIAL_TEMP);
    this.service.setCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, INITIAL_TEMP);

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onGet(this.handleCoolingThresholdTemperatureGet.bind(this))
      .onSet(this.handleCoolingThresholdTemperatureSet.bind(this))
      .setProps({
        minValue: MIN_TEMP,
        maxValue: MAX_TEMP,
        minStep: 1,
      });

    // The A/C has a single set point, but the Home app renders the `auto` target
    // state as a heating/cooling *range* and hides the temperature slider
    // completely when only one of the two threshold characteristics exists. Both
    // are therefore exposed and kept in sync with the same value; writing either
    // one sets the A/C temperature.
    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onGet(this.handleCoolingThresholdTemperatureGet.bind(this))
      .onSet(this.handleCoolingThresholdTemperatureSet.bind(this))
      .setProps({
        minValue: MIN_TEMP,
        maxValue: MAX_TEMP,
        minStep: 1,
      });

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.handleSwingModeGet.bind(this))
      .onSet(this.handleSwingModeSet.bind(this));

    // The helper switches (vertical/horizontal swing, display light, quiet,
    // econo, clean, turbo and sleep mode) are published as their own accessories
    // so that the Home app shows a proper label for each of them - see
    // `getSwitchDefinitions()` and `switchAccessory.ts`.
    for (const service of [...this.accessory.services]) {
      if (service instanceof this.platform.Service.Switch) {
        // Versions up to 1.0.9 exposed the switches as extra services of this
        // accessory; they are also persisted in the Homebridge cache, so drop
        // them to avoid duplicate (mis-labelled) tiles in the Home app.
        this.platform.log.info('Removing legacy switch service from the A/C accessory:', service.displayName || service.subtype);
        this.accessory.removeService(service);
      }
    }

    this.acstate = {
      On: false,
      // Characteristic.CurrentHeaterCoolerState: 0 = INACTIVE, 1 = IDLE,
      // 2 = HEATING, 3 = COOLING. The A/C starts off, so the reported state must
      // be INACTIVE - reporting "cooling" while the accessory is off makes the
      // Home app render the tile without its controls.
      Mode: this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE,
      TargetMode: this.platform.Characteristic.TargetHeaterCoolerState.COOL,
      TargetTemp: INITIAL_TEMP,
      DefaultTemp: 24,
      rotationSpeed: 1,
      CurrentTemp: INITIAL_TEMP,
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
    // The vertical swing is exposed as a slider by default. Set
    // `swingControl: "switch"` for the classic Vertical Swing switch plus one
    // switch per vane position, or `swingControl: "picker"` for a single chooser
    // accessory listing every vane position.
    const configuredSwingControl = accessory.context.device.swingControl;
    this.swingControl = configuredSwingControl === 'switch' || configuredSwingControl === 'picker'
      ? configuredSwingControl
      : 'slider';
    // Publish a valid set point before HomeKit reads the accessory: the HAP
    // default for the threshold characteristics (10 °C) is outside the
    // configured range, and an out-of-range value makes the Home app drop the
    // temperature slider.
    this.applyTargetTemperature(this.acstate.TargetTemp);
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
    this.clearTurboSync();
    this.mqttClient?.end();
  }
  /**
   * Name of the A/C accessory. Only used for log messages; the helper switches
   * are named after `getSwitchDefinitions()`.
   */
  public get name(): string {
    return this.accessory.displayName;
  }

  /** `switchNamePrefix` of the device (`""` when not configured). */
  private get namePrefix(): string {
    const prefix = this.accessory.context.device.switchNamePrefix;
    return typeof prefix === 'string' ? prefix : '';
  }

  /**
   * The helper switches this A/C exposes. Each one is published as a separate
   * accessory (`switchAccessory.ts`) so that the Home app shows its own label
   * instead of the name of the A/C accessory.
   *
   * Every switch is optional: set the matching `enable…` option to `false` to
   * hide it. When an option is not present in `config.json` the documented
   * default is used, so existing configurations keep working unchanged.
   */
  public getSwitchDefinitions(): SwitchDefinition[] {
    const device = this.accessory.context.device;
    const label = (text: string) => `${this.namePrefix}${text}`;

    const definitions: SwitchDefinition[] = [];

    // Dedicated switch for vertical swing: several HomeKit clients (the Apple
    // Home app in particular) don't render the optional SwingMode characteristic
    // of a HeaterCooler service, so a switch is the reliable way to control it.
    // Only used when `swingControl` is "switch", otherwise the swing slider
    // accessory (`getSwingSliderDefinition()`) covers this.
    if (this.swingControl === 'switch' && device.enableSwingV !== false) {
      definitions.push({ subtype: 'swingv', name: label('Vertical Swing') });
    }

    // Horizontal swing is only supported by a subset of LG models (e.g. the
    // AKB73757604 remote), so it is opt-in.
    if (device.enableSwingH === true) {
      definitions.push({ subtype: 'swingh', name: label('Horizontal Swing') });
    }

    // The display light is supported by the LG protocol. Opt-in so existing
    // setups don't suddenly gain an extra switch.
    if (device.enableLight === true) {
      definitions.push({ subtype: 'light', name: label('Display Light') });
    }

    // Quiet / Econo / Clean. The IRMQTTServer sketch accepts and echoes these
    // topics, but the LG IR protocol itself ignores them (they are useful for
    // other A/C protocols).
    if (device.enableQuiet !== false) {
      definitions.push({ subtype: 'quiet', name: label('Quiet') });
    }
    if (device.enableEcono !== false) {
      definitions.push({ subtype: 'econo', name: label('Econo') });
    }
    if (device.enableClean !== false) {
      definitions.push({ subtype: 'clean', name: label('Clean') });
    }

    // Vertical swing position selector: one mutually-exclusive switch per fixed
    // louvre position. "Auto" (continuous swing) lives on the Vertical Swing
    // switch. Only used when `swingControl` is "switch".
    if (this.swingControl === 'switch' && device.enableSwingPosition !== false) {
      for (const { position, name } of SWING_POSITIONS) {
        definitions.push({ subtype: `${SWING_POSITION_SUBTYPE_PREFIX}${position}`, name: label(name) });
      }
    }

    // Turbo: accepted and echoed by the sketch, ignored by the LG protocol.
    if (device.enableTurbo !== false) {
      definitions.push({ subtype: 'turbo', name: label('Turbo Mode') });
    }

    // "Sleep Mode" (previously "Low Fan Preset") applies a quiet preset and
    // automatically turns the A/C off after `sleepMinutes` (default 60). The LG
    // IR protocol has no native sleep timer, so the countdown is run by the
    // plugin. The subtype is kept as 'low-fan-preset' so existing cached
    // accessories are reused instead of duplicated.
    if (device.enableSleep !== false) {
      definitions.push({ subtype: 'low-fan-preset', name: label('Sleep Mode') });
    }

    return definitions;
  }

  /**
   * Current state of a helper switch, as tracked from the A/C state (which is
   * updated from the MQTT status topics).
   */
  public getSwitchState(subtype: string): boolean {
    if (subtype.startsWith(SWING_POSITION_SUBTYPE_PREFIX)) {
      return this.acstate.SwingPosition === subtype.slice(SWING_POSITION_SUBTYPE_PREFIX.length);
    }
    const states: Record<string, boolean> = {
      'swingv': this.acstate.Swing,
      'swingh': this.acstate.SwingH,
      'light': this.acstate.Light,
      'quiet': this.acstate.Quiet,
      'econo': this.acstate.Econo,
      'clean': this.acstate.Clean,
      'turbo': this.acstate.Turbo,
      'low-fan-preset': this.acstate.Sleep,
    };
    return states[subtype] ?? false;
  }

  /**
   * Handle a "SET" request coming from one of the helper switches.
   */
  public async setSwitchState(subtype: string, value: CharacteristicValue): Promise<void> {
    if (subtype.startsWith(SWING_POSITION_SUBTYPE_PREFIX)) {
      await this.handleSwingPositionSet(subtype.slice(SWING_POSITION_SUBTYPE_PREFIX.length), value);
      return;
    }
    const handlers: Record<string, (onOff: CharacteristicValue) => Promise<void>> = {
      'swingv': this.handleSwingSwitchSet.bind(this),
      'swingh': this.handleSwingHSwitchSet.bind(this),
      'light': this.handleLightSet.bind(this),
      'quiet': this.handleQuietSet.bind(this),
      'econo': this.handleEconoSet.bind(this),
      'clean': this.handleCleanSet.bind(this),
      'turbo': this.handleTurboSet.bind(this),
      'low-fan-preset': this.handleSleepModeSet.bind(this),
    };
    const handler = handlers[subtype];
    if (!handler) {
      this.platform.log.warn(`Unknown switch '${subtype}' for ${this.accessory.displayName}.`);
      return;
    }
    await handler(value);
  }

  /**
   * Called by `IRMQTTSwitchAccessory` once its switch service exists, so that
   * A/C state changes can be pushed to it.
   */
  public attachSwitchService(subtype: string, service: Service): void {
    this.switchServices.set(subtype, service);
    service.updateCharacteristic(this.platform.Characteristic.On, this.getSwitchState(subtype));
  }

  /**
   * Push the state of a helper switch to the Home app (a no-op when the
   * corresponding switch accessory is not published).
   */
  private updateSwitchState(subtype: string, on: boolean): void {
    this.switchServices.get(subtype)?.updateCharacteristic(this.platform.Characteristic.On, on);
  }

  /**
   * Apply the A/C set point.
   *
   * The A/C only has a single target temperature, so both HeaterCooler threshold
   * characteristics are kept in sync with it: the Home app renders the `auto`
   * target state as a heating/cooling range and hides the temperature slider
   * when only one of the two exists. The value is clamped to the range the LG
   * protocol supports (`MIN_TEMP`–`MAX_TEMP`), because an out-of-range value is
   * rejected by HomeKit and the slider disappears.
   */
  private applyTargetTemperature(value: number): void {
    const clamped = Math.min(MAX_TEMP, Math.max(MIN_TEMP, Math.round(value)));
    if (clamped !== value) {
      this.platform.log.debug(`Clamped target temperature ${value} to ${clamped} (supported range ${MIN_TEMP}-${MAX_TEMP} °C).`);
    }
    this.acstate.TargetTemp = clamped;
    this.acstate.CurrentTemp = clamped;
    this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, clamped);
    this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, clamped);
    // The sketch cannot report the real room temperature, so the "current"
    // temperature mirrors the set point - the Home app then shows the target
    // temperature in both places (this is how 1.0.8 behaved as well).
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, clamped);
  }

  /**
   * The swing slider accessory (see `swingAccessory.ts`), or `null` when the
   * vertical swing is exposed as switches (`swingControl: "switch"`) or disabled
   * with `enableSwingV: false`.
   */
  public getSwingSliderDefinition(): SwitchDefinition | null {
    if (this.swingControl !== 'slider' || this.accessory.context.device.enableSwingV === false) {
      return null;
    }
    return { subtype: SWING_SLIDER_SUBTYPE, name: `${this.namePrefix}Swing` };
  }

  /**
   * Slider position (0–100) of the swing accessory, derived from the last
   * `swingv` value reported by the A/C.
   */
  public getSwingSliderValue(): number {
    const stop = SWING_SLIDER_STOPS.find(candidate => candidate.swingv === this.acstate.SwingPosition);
    if (stop) {
      return stop.value;
    }
    // The A/C reported something unusual ("swing", "1", …), so fall back to the
    // discrete swing state: continuous swing = 100 %, parked at the last
    // position = 0 %.
    return this.acstate.Swing ? 100 : 0;
  }

  /** `On` of the swing accessory: false only while the vanes are parked off. */
  public getSwingSliderOn(): boolean {
    return this.getSwingSliderValue() > 0;
  }

  /** Handle a slider change coming from the Home app. */
  public async setSwingSliderValue(value: number): Promise<void> {
    const stop = IRMQTTPlatformAccessory.swingSliderStopFor(value);
    await this.applySwingv(stop.swingv);
  }

  /** Handle the on/off toggle of the swing accessory (on = continuous swing). */
  public async setSwingSliderOn(on: boolean): Promise<void> {
    await this.setSwingV(on);
  }

  /**
   * Called by `IRMQTTSwingSliderAccessory` once its service exists, so that A/C
   * state changes can be pushed to the slider.
   */
  public attachSwingSliderService(service: Service): void {
    this.swingSliderService = service;
    this.pushSwingSliderState();
  }

  /** Push the current swing state to the slider accessory. */
  private pushSwingSliderState(): void {
    if (!this.swingSliderService) {
      return;
    }
    const value = this.getSwingSliderValue();
    this.swingSliderService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, value);
    this.swingSliderService.updateCharacteristic(this.platform.Characteristic.On, value > 0);
  }

  /**
   * The swing picker accessory (see `swingPickerAccessory.ts`), or `null` when
   * the vertical swing is exposed as a slider/switch (`swingControl: "slider"`
   * / `"switch"`) or disabled with `enableSwingV: false`.
   */
  public getSwingPickerDefinition(): SwitchDefinition | null {
    if (this.swingControl !== 'picker' || this.accessory.context.device.enableSwingV === false) {
      return null;
    }
    return { subtype: SWING_PICKER_SUBTYPE, name: `${this.namePrefix}Swing` };
  }

  /** The vane positions offered by the picker accessory. */
  public getSwingPickerOptions(): ReadonlyArray<SwingPickerOption> {
    return SWING_PICKER_OPTIONS;
  }

  /** Identifier of the option matching the last reported `swingv` value. */
  public getSwingPickerActiveIdentifier(): number {
    const option = SWING_PICKER_OPTIONS.find(candidate => candidate.swingv === this.acstate.SwingPosition);
    return option ? option.id : SWING_PICKER_OPTIONS[0].id;
  }

  /** The picker is "on" whenever the vanes are not parked off. */
  public getSwingPickerActive(): boolean {
    return this.acstate.SwingPosition !== 'off';
  }

  /** Apply the vane position the user picked from the list. */
  public async setSwingPickerIdentifier(id: number): Promise<void> {
    const option = SWING_PICKER_OPTIONS.find(candidate => candidate.id === id);
    if (!option) {
      this.platform.log.warn(`Unknown swing picker identifier '${id}' for ${this.accessory.displayName}.`);
      return;
    }
    await this.applySwingv(option.swingv);
  }

  /** Handle the picker's power toggle (on = continuous swing, off = park). */
  public async setSwingPickerActive(on: boolean): Promise<void> {
    await this.setSwingV(on);
  }

  /** Step to the next/previous vane position (used by the remote arrow keys). */
  public async stepSwingPicker(delta: number): Promise<void> {
    const currentIndex = SWING_PICKER_OPTIONS.findIndex(
      candidate => candidate.id === this.getSwingPickerActiveIdentifier());
    const index = currentIndex < 0 ? 0 : currentIndex;
    const next = (index + delta + SWING_PICKER_OPTIONS.length) % SWING_PICKER_OPTIONS.length;
    await this.setSwingPickerIdentifier(SWING_PICKER_OPTIONS[next].id);
  }

  /**
   * Called by `IRMQTTSwingPickerAccessory` once its service exists, so that A/C
   * state changes can be pushed to the chooser.
   */
  public attachSwingPickerService(service: Service): void {
    this.swingPickerService = service;
    this.pushSwingPickerState();
  }

  /** Push the current swing state to the picker accessory. */
  private pushSwingPickerState(): void {
    if (!this.swingPickerService) {
      return;
    }
    this.swingPickerService.updateCharacteristic(
      this.platform.Characteristic.Active,
      this.getSwingPickerActive()
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE);
    this.swingPickerService.updateCharacteristic(
      this.platform.Characteristic.ActiveIdentifier,
      this.getSwingPickerActiveIdentifier());
  }

  /** The slider stop closest to the value the Home app sent. */
  private static swingSliderStopFor(value: number): { value: number; swingv: string } {
    let nearest = SWING_SLIDER_STOPS[0];
    for (const stop of SWING_SLIDER_STOPS) {
      if (Math.abs(stop.value - value) < Math.abs(nearest.value - value)) {
        nearest = stop;
      }
    }
    return nearest;
  }

  /** Apply a `swingv` payload and refresh every swing related HomeKit control. */
  private async applySwingv(swingv: string): Promise<void> {
    if (swingv === 'off') {
      await this.setSwingV(false);
      return;
    }
    if (swingv === 'auto') {
      await this.setSwingV(true);
      return;
    }
    await this.setSwingPosition(swingv);
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
      // Switching the A/C off cancels any running sleep timer and turbo boost.
      this.stopSleepMode();
      this.stopTurboMode();
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

    // Reflect the change in HomeKit straight away; the MQTT status topics then
    // confirm it. Without this the tile can stay in its previous state (e.g. the
    // temperature slider stays hidden because the accessory is still "off").
    this.service.updateCharacteristic(this.platform.Characteristic.Active,
      this.acstate.On ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.acstate.Mode);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.acstate.TargetMode);
    this.applyTargetTemperature(this.acstate.TargetTemp);
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
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.acstate.Mode);
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
    const numeric = typeof value === 'number' ? value : Number(value);
    this.applyTargetTemperature(numeric);
    await this.publishMessage(this.mqttTopic.temp, this.acstate.TargetTemp.toString());
    // A changed set point no longer matches the sleep preset, so re-evaluate the
    // Sleep Mode switch here instead of waiting for the A/C to echo `stat/temp`.
    this.scheduleSleepSync();
    // Changing the set point also cancels an active turbo boost.
    this.scheduleTurboSync();
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
    // A changed fan speed no longer matches the sleep preset (minimum fan), so
    // re-evaluate the Sleep Mode switch instead of waiting for the `stat` echo.
    this.scheduleSleepSync();
    // Changing the fan speed also cancels an active turbo boost.
    this.scheduleTurboSync();
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
   * Keep the SwingMode characteristic, the swing slider accessory and every
   * swing switch in sync with the reported A/C state.
   */
  private syncSwingCharacteristics(): void {
    const swinging = this.acstate.Swing;
    this.service.updateCharacteristic(this.platform.Characteristic.SwingMode,
      swinging ? this.platform.Characteristic.SwingMode.SWING_ENABLED : this.platform.Characteristic.SwingMode.SWING_DISABLED);
    this.updateSwitchState('swingv', swinging);
    for (const [subtype, service] of this.switchServices) {
      if (!subtype.startsWith(SWING_POSITION_SUBTYPE_PREFIX)) {
        continue;
      }
      const position = subtype.slice(SWING_POSITION_SUBTYPE_PREFIX.length);
      service.updateCharacteristic(this.platform.Characteristic.On, this.acstate.SwingPosition === position);
    }
    this.pushSwingSliderState();
    this.pushSwingPickerState();
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
    // Leaving the "lowest" position leaves the sleep preset.
    this.scheduleSleepSync();
    // Changing the swing also cancels an active turbo boost.
    this.scheduleTurboSync();
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
    // Only the "lowest" position is part of the sleep preset.
    this.scheduleSleepSync();
    // Changing the swing also cancels an active turbo boost.
    this.scheduleTurboSync();
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
    this.updateSwitchState('swingh', this.acstate.SwingH);
    this.platform.log.debug(this.accessory.displayName, 'Set Horizontal Swing -> ', this.acstate.SwingH);
  }

  private async handleLightSet(value: CharacteristicValue) {
    this.acstate.Light = value === true;
    await this.publishMessage(this.mqttTopic.light, this.acstate.Light ? "on" : "off");
    this.updateSwitchState('light', this.acstate.Light);
    this.platform.log.debug(this.accessory.displayName, 'Set Display Light -> ', this.acstate.Light);
  }

  private async handleQuietSet(value: CharacteristicValue) {
    this.acstate.Quiet = value === true;
    await this.publishMessage(this.mqttTopic.quiet, this.acstate.Quiet ? "on" : "off");
    this.updateSwitchState('quiet', this.acstate.Quiet);
    this.platform.log.debug(this.accessory.displayName, 'Set Quiet -> ', this.acstate.Quiet);
  }

  private async handleEconoSet(value: CharacteristicValue) {
    this.acstate.Econo = value === true;
    await this.publishMessage(this.mqttTopic.econo, this.acstate.Econo ? "on" : "off");
    this.updateSwitchState('econo', this.acstate.Econo);
    this.platform.log.debug(this.accessory.displayName, 'Set Econo -> ', this.acstate.Econo);
  }

  private async handleCleanSet(value: CharacteristicValue) {
    this.acstate.Clean = value === true;
    await this.publishMessage(this.mqttTopic.clean, this.acstate.Clean ? "on" : "off");
    this.updateSwitchState('clean', this.acstate.Clean);
    this.platform.log.debug(this.accessory.displayName, 'Set Clean -> ', this.acstate.Clean);
  }

  /**
   * Turbo Mode: a transient boost. Switching it on snapshots the current set
   * point, fan speed and vane position; as soon as any of them changes the
   * switch turns itself off again (see `syncTurboSwitch`).
   */
  private async handleTurboSet(value: CharacteristicValue) {
    const on = value === true;
    this.clearTurboSync();
    if (on) {
      this.turboEnabledAt = Date.now();
      this.captureTurboBaseline();
    } else {
      this.turboBaseline = null;
    }
    this.acstate.Turbo = on;
    await this.publishMessage(this.mqttTopic.turbo, on ? "on" : "off");
    // Keep the switch authoritative even when triggered programmatically.
    this.updateSwitchState('turbo', on);
    this.platform.log.debug(this.accessory.displayName, 'Set Turbo Mode -> ', on);
  }

  /** Snapshot the settings turbo was switched on with. */
  private captureTurboBaseline(): void {
    this.turboBaseline = {
      temp: this.acstate.TargetTemp,
      rotationSpeed: IRMQTTPlatformAccessory.normalizeRotationSpeed(this.acstate.rotationSpeed),
      swingv: this.acstate.SwingPosition,
    };
  }

  /**
   * Debounced re-evaluation of the Turbo Mode switch. Enabling turbo and the
   * changes that follow make the A/C echo several `stat` messages, so
   * coalescing them avoids flicker.
   */
  private scheduleTurboSync(): void {
    if (this.turboSyncTimeout) {
      clearTimeout(this.turboSyncTimeout);
    }
    this.turboSyncTimeout = setTimeout(() => {
      this.turboSyncTimeout = null;
      this.syncTurboSwitch();
    }, 750);
  }

  private clearTurboSync(): void {
    if (this.turboSyncTimeout) {
      clearTimeout(this.turboSyncTimeout);
      this.turboSyncTimeout = null;
    }
  }

  /**
   * Reflect the real A/C state on the Turbo Mode switch: it is "on" only while
   * the set point, fan speed and vane position still match the settings it was
   * switched on with. Change any of them from the IR remote, the A/C itself, the
   * Home app or another MQTT client and turbo is cancelled (both on the switch
   * and on the `turbo` topic, so every client stays in sync).
   */
  private syncTurboSwitch(): void {
    if (!this.acstate.Turbo || !this.turboBaseline) {
      return;
    }
    // Enabling turbo (and reconnecting to the broker) makes the A/C / broker
    // publish a burst of retained `stat` messages. Absorb them into the baseline
    // instead of treating them as a user change, so a freshly enabled boost is
    // not cancelled by its own echo.
    if (Date.now() - this.turboEnabledAt < 2000) {
      this.captureTurboBaseline();
      return;
    }
    const baseline = this.turboBaseline;
    const changed = baseline.temp !== this.acstate.TargetTemp
      || baseline.rotationSpeed !== IRMQTTPlatformAccessory.normalizeRotationSpeed(this.acstate.rotationSpeed)
      || baseline.swingv !== this.acstate.SwingPosition;
    if (!changed) {
      return;
    }
    this.acstate.Turbo = false;
    this.turboBaseline = null;
    this.updateSwitchState('turbo', false);
    void this.publishMessage(this.mqttTopic.turbo, "off");
    this.platform.log.info(`${this.accessory.displayName}: Turbo mode cancelled because the A/C settings changed.`);
  }

  /**
   * Cancel turbo mode without sending any commands (used when the A/C is
   * switched off by other means, e.g. from the Home app or the IR remote).
   */
  private stopTurboMode(): void {
    this.clearTurboSync();
    this.turboBaseline = null;
    if (this.acstate.Turbo) {
      this.acstate.Turbo = false;
      this.updateSwitchState('turbo', false);
    }
  }

  /**
   * Normalise a `rotationSpeed` percentage onto the four `fanspeed` levels the
   * sketch understands (auto / min / medium / max). Both the Home app (raw
   * percentage) and the `stat` echo (25/50/75/100) are mapped the same way, so
   * the turbo baseline and the live state can be compared without spurious
   * differences.
   */
  private static normalizeRotationSpeed(value: number): number {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return 100;
    }
    if (numericValue >= 75) {
      return 75;
    }
    if (numericValue >= 50) {
      return 50;
    }
    if (numericValue >= 25) {
      return 25;
    }
    return 100;
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
      // The vanes are parked at the lowest position, so vertical swing is off.
      this.acstate.Swing = false;
      this.acstate.SwingPosition = "lowest";
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 25);
      this.applyTargetTemperature(this.sleepTemp);
      this.syncSwingCharacteristics();
      this.startSleepTimer();
    } else {
      this.platform.log.info(`${this.accessory.displayName}: Sleep mode cancelled.`);
    }
    // Keep the switch authoritative even when triggered programmatically.
    this.updateSwitchState('low-fan-preset', on);
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
      this.updateSwitchState('low-fan-preset', active);
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
      this.updateSwitchState('low-fan-preset', false);
    }
  }

  private async onSleepTimerExpired(): Promise<void> {
    this.sleepTimeout = null;
    this.acstate.Sleep = false;
    this.acstate.LowFanPreset = false;
    this.platform.log.info(`${this.accessory.displayName}: Sleep timer expired, turning the A/C off.`);
    this.updateSwitchState('low-fan-preset', false);
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
          // sleep timer is no longer relevant and turbo is cancelled too.
          this.stopSleepMode();
          this.stopTurboMode();
        }
        this.service.updateCharacteristic(this.platform.Characteristic.Active,
          value ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
      } else if (topic === this.mqttTopic.tempstat) {
        const value = Number(message);
        if (!Number.isFinite(value)) {
          throw new Error(`Invalid temperature payload: ${message}`);
        }
        this.applyTargetTemperature(value);
        this.scheduleSleepSync();
        this.scheduleTurboSync();
      } else if (topic === this.mqttTopic.swingstat) {
        // Only "auto" (continuous swing) means swing is on. Discrete vane
        // positions such as "lowest" park the louvres, so swing is off.
        this.acstate.SwingPosition = message;
        this.acstate.Swing = message === "auto" || message === "swing" || message === "1";
        this.syncSwingCharacteristics();
        this.scheduleSleepSync();
        this.scheduleTurboSync();
      } else if (topic === this.mqttTopic.swinghstat) {
        const value = message !== "off" && message !== "0";
        this.acstate.SwingH = value;
        this.updateSwitchState('swingh', value);
      } else if (topic === this.mqttTopic.turbostat) {
        const value = message === "on";
        if (value) {
          // Snapshot the settings turbo was switched on with, so that a later
          // change to any of them cancels turbo again. Re-baseline only when the
          // switch was off (e.g. turbo enabled from the IR remote), so a change
          // made from the Home app keeps the original snapshot.
          if (!this.acstate.Turbo) {
            this.acstate.Turbo = true;
            this.turboEnabledAt = Date.now();
            this.captureTurboBaseline();
          }
        } else {
          this.acstate.Turbo = false;
          this.turboBaseline = null;
          this.clearTurboSync();
        }
        this.updateSwitchState('turbo', value);
      } else if (topic === this.mqttTopic.lightstat) {
        const value = message === "on";
        this.acstate.Light = value;
        this.updateSwitchState('light', value);
      } else if (topic === this.mqttTopic.quietstat) {
        const value = message === "on";
        this.acstate.Quiet = value;
        this.updateSwitchState('quiet', value);
      } else if (topic === this.mqttTopic.econostat) {
        const value = message === "on";
        this.acstate.Econo = value;
        this.updateSwitchState('econo', value);
      } else if (topic === this.mqttTopic.cleanstat) {
        const value = message === "on";
        this.acstate.Clean = value;
        this.updateSwitchState('clean', value);
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
        this.scheduleTurboSync();
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
