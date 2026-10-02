import type { PlatformAccessory, Service } from 'homebridge';
import packageJson from '../package.json' with { type: 'json' };
import type { IRMQTTHomebridgePlatform } from './platform.js';
import type { IRMQTTPlatformAccessory, SwitchDefinition } from './platformAccessory.js';

/**
 * A single helper switch (vertical/horizontal swing, display light, quiet,
 * econo, clean, turbo, sleep mode or one of the fixed vane positions).
 *
 * The Apple Home app labels every tile with the name of the **accessory** the
 * service belongs to, so helper switches exposed as extra `Service.Switch`
 * entries on the A/C accessory were all displayed as "LG AC". Publishing each
 * switch as its own accessory (with its own name and UUID) gives every switch
 * the label defined by `IRMQTTPlatformAccessory.getSwitchDefinitions()`.
 *
 * All switches of one A/C device share a single `IRMQTTPlatformAccessory`
 * instance, which owns the MQTT connection and the A/C state.
 */
export class IRMQTTSwitchAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: IRMQTTHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: IRMQTTPlatformAccessory,
    private readonly definition: SwitchDefinition,
  ) {
    // The name follows the configuration, so a changed `switchNamePrefix` is
    // also applied to accessories restored from the Homebridge cache.
    this.accessory.updateDisplayName(this.definition.name);

    // set accessory information. `Name` is the label the Home app shows on the
    // tile, so it must be updated too when an accessory is restored from the
    // cache with a different `switchNamePrefix`.
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Name, this.definition.name)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'AC')
      .setCharacteristic(this.platform.Characteristic.Model, 'IRMQTT-Switch')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.serialNumber());

    // A dedicated accessory only ever holds a single switch service, so no
    // subtype is required (that is only needed for several switches sharing one
    // accessory).
    this.service = this.accessory.getService(this.platform.Service.Switch)
      || this.accessory.addService(this.platform.Service.Switch, this.definition.name);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.definition.name);
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.device.getSwitchState(this.definition.subtype))
      .onSet(value => this.device.setSwitchState(this.definition.subtype, value));

    // Register with the A/C handler so it can push state changes (coming from
    // the IR remote, another MQTT client or the A/C itself) to this switch.
    this.device.attachSwitchService(this.definition.subtype, this.service);

    this.platform.log.debug(`[${this.device.name}] Switch '${this.definition.name}' ready (${this.definition.subtype}).`);
  }

  private serialNumber(): string {
    const uniqueId = this.accessory.context.device?.UniqueId;
    return uniqueId ? `${uniqueId}:${this.definition.subtype}` : `${packageJson.version}:${this.definition.subtype}`;
  }
}
