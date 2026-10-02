import type { PlatformAccessory, Service } from 'homebridge';
import packageJson from '../package.json' with { type: 'json' };
import type { IRMQTTHomebridgePlatform } from './platform.js';
import type { IRMQTTPlatformAccessory, SwitchDefinition } from './platformAccessory.js';

/**
 * The vertical swing as a single picker ("chooser").
 *
 * HomeKit has no generic dropdown control, but a `Television` service combines
 * a power state with a list of linked `InputSource` entries, which the Home app
 * renders as a chooser: tap the accessory and pick one of its inputs. The seven
 * `swingv` values are mapped onto seven input sources - `Off`, `Lowest`, `Low`,
 * `Middle`, `High`, `Highest` and `Auto` (continuous swing) - so exactly one of
 * them is highlighted at any time.
 *
 * Set `swingControl: "picker"` in the device configuration for this layout.
 * `IRMQTTPlatformAccessory` owns the vane mapping, the A/C state and the MQTT
 * connection.
 */
export class IRMQTTSwingPickerAccessory {
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
      .setCharacteristic(this.platform.Characteristic.Model, 'IRMQTT-SwingPicker')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.serialNumber());

    // A dedicated accessory only holds the Television service plus its linked
    // input sources.
    this.service = this.accessory.getService(this.platform.Service.Television)
      || this.accessory.addService(this.platform.Service.Television, this.definition.name);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.definition.name);
    this.service.getCharacteristic(this.platform.Characteristic.ConfiguredName).setValue(this.definition.name);
    this.service.setCharacteristic(
      this.platform.Characteristic.SleepDiscoveryMode,
      this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    // "On" means the vanes are not parked off (auto or a fixed position); "off"
    // parks them, exactly like the swing slider's toggle.
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.device.getSwingPickerActive()
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE)
      .onSet((value) => this.device.setSwingPickerActive(value === this.platform.Characteristic.Active.ACTIVE));

    this.service.getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .onGet(() => this.device.getSwingPickerActiveIdentifier())
      .onSet((value) => this.device.setSwingPickerIdentifier(Number(value)));

    // The Home app's TV remote sends arrow keys; map them to stepping through
    // the vane positions. Every other key is ignored.
    this.service.getCharacteristic(this.platform.Characteristic.RemoteKey)
      .onSet(async (value) => {
        if (value === this.platform.Characteristic.RemoteKey.ARROW_UP) {
          await this.device.stepSwingPicker(1);
        } else if (value === this.platform.Characteristic.RemoteKey.ARROW_DOWN) {
          await this.device.stepSwingPicker(-1);
        }
      });

    // One input source per vane position. `subtype` keeps the same HomeKit
    // entry (and its assigned room/name) across restarts.
    for (const option of this.device.getSwingPickerOptions()) {
      const subtype = `${this.definition.subtype}-${option.swingv}`;
      const inputSource = this.accessory.getServiceById(this.platform.Service.InputSource, subtype)
        || this.accessory.addService(
          this.platform.Service.InputSource,
          `${this.definition.name} ${option.name}`,
          subtype);
      inputSource.setCharacteristic(this.platform.Characteristic.Identifier, option.id);
      inputSource.getCharacteristic(this.platform.Characteristic.ConfiguredName).setValue(option.name);
      inputSource.getCharacteristic(this.platform.Characteristic.IsConfigured)
        .setValue(this.platform.Characteristic.IsConfigured.CONFIGURED);
      inputSource.getCharacteristic(this.platform.Characteristic.InputSourceType)
        .setValue(this.platform.Characteristic.InputSourceType.OTHER);
      inputSource.getCharacteristic(this.platform.Characteristic.CurrentVisibilityState)
        .setValue(this.platform.Characteristic.CurrentVisibilityState.SHOWN);
      inputSource.getCharacteristic(this.platform.Characteristic.TargetVisibilityState)
        .setValue(this.platform.Characteristic.TargetVisibilityState.SHOWN);
      this.service.addLinkedService(inputSource);
    }

    // Register with the A/C handler so it can push state changes (coming from
    // the IR remote, another MQTT client or the A/C itself) to the chooser.
    this.device.attachSwingPickerService(this.service);

    this.platform.log.debug(`[${this.device.name}] Swing picker '${this.definition.name}' ready.`);
  }

  private serialNumber(): string {
    const uniqueId = this.accessory.context.device?.UniqueId;
    return uniqueId ? `${uniqueId}:${this.definition.subtype}` : `${packageJson.version}:${this.definition.subtype}`;
  }
}
