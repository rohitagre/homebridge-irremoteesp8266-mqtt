import type { PlatformAccessory, Service } from 'homebridge';
import packageJson from '../package.json' with { type: 'json' };
import type { IRMQTTHomebridgePlatform } from './platform.js';
import type { IRMQTTPlatformAccessory, SwitchDefinition } from './platformAccessory.js';

/**
 * The vertical swing as a single slider.
 *
 * HomeKit has no generic "select" control, but a `Fan` service is rendered by
 * the Apple Home app as a slider, which suits the ordered `swingv` values:
 * `off` (0 %) → `lowest` (17 %) → `low` (33 %) → `middle` (50 %) → `high` (67 %)
 * → `highest` (83 %) → `auto` (100 %, continuous swing). The slider snaps to
 * those seven levels - `IRMQTTPlatformAccessory` owns the mapping, the A/C state
 * and the MQTT connection.
 *
 * Set `swingControl: "switch"` in the device configuration for the classic
 * `Vertical Swing` switch plus one switch per vane position instead.
 */
export class IRMQTTSwingSliderAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: IRMQTTHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: IRMQTTPlatformAccessory,
    private readonly definition: SwitchDefinition,
  ) {
    // The name follows the configuration, so a changed `switchNamePrefix` is
    // also applied to an accessory restored from the Homebridge cache.
    this.accessory.updateDisplayName(this.definition.name);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Name, this.definition.name)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'AC')
      .setCharacteristic(this.platform.Characteristic.Model, 'IRMQTT-Swing')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.serialNumber());

    // A `Fan` service gives the Home app tile a slider (RotationSpeed) plus an
    // on/off toggle; a dedicated accessory only holds this single service.
    this.service = this.accessory.getService(this.platform.Service.Fan)
      || this.accessory.addService(this.platform.Service.Fan, this.definition.name);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.definition.name);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.device.getSwingSliderOn())
      .onSet(value => this.device.setSwingSliderOn(value === true));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(() => this.device.getSwingSliderValue())
      .onSet(value => this.device.setSwingSliderValue(typeof value === 'number' ? value : Number(value)))
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 });

    // Register with the A/C handler so it can push state changes (coming from
    // the IR remote, another MQTT client or the A/C itself) to the slider.
    this.device.attachSwingSliderService(this.service);

    this.platform.log.debug(`[${this.device.name}] Swing slider '${this.definition.name}' ready.`);
  }

  private serialNumber(): string {
    const uniqueId = this.accessory.context.device?.UniqueId;
    return uniqueId ? `${uniqueId}:${this.definition.subtype}` : `${packageJson.version}:${this.definition.subtype}`;
  }
}
