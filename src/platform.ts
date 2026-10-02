import {
  Categories,
  type API,
  type Characteristic,
  type DynamicPlatformPlugin,
  type Logging,
  type PlatformAccessory,
  type PlatformConfig,
  type Service,
} from 'homebridge';

import { IRMQTTPlatformAccessory } from './platformAccessory.js';
import type { SwitchDefinition } from './platformAccessory.js';
import { IRMQTTSwitchAccessory } from './switchAccessory.js';
import { IRMQTTSwingSliderAccessory } from './swingAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class IRMQTTHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];
  private readonly accessoryHandlers: IRMQTTPlatformAccessory[] = [];

  // This is only required when using Custom Services and Characteristics not support by HomeKit

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomCharacteristics: any;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      for (const handler of this.accessoryHandlers) {
        handler.shutdown();
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    // EXAMPLE ONLY
    // A real plugin you would discover accessories from the local network, cloud services
    // or a user-defined array in the platform config.
    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
    this.log.debug('Discovering devices:', devices.length);
    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devices) {
      if (!device || typeof device.UniqueId !== 'string' || device.UniqueId.trim() === '') {
        this.log.error('Skipping device without a stable UniqueId.');
        continue;
      }
      if (!device.mqtt?.server || !device.mqtt?.prefix) {
        this.log.error(`Skipping device '${device.UniqueId}': MQTT server and prefix are required.`);
        continue;
      }
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.UniqueId);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // Keep the accessory context in sync with the current configuration:
        // restored accessories otherwise keep the device settings stored in the
        // Homebridge cache, so config changes (enable flags, sleepMinutes, MQTT
        // settings, …) would only apply after the cache is deleted.
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        const handler = new IRMQTTPlatformAccessory(this, existingAccessory);
        this.accessoryHandlers.push(handler);
        this.publishControlAccessories(existingAccessory, handler);

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, e.g.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.displayName);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.displayName, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        const handler = new IRMQTTPlatformAccessory(this, accessory);
        this.accessoryHandlers.push(handler);
        this.publishControlAccessories(accessory, handler);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    // you can also deal with accessories from the cache which are no longer present by removing them from Homebridge
    // for example, if your plugin logs into a cloud account to retrieve a device list, and a user has previously removed a device
    // from this cloud account, then this device will no longer be present in the device list but will still be in the Homebridge cache
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Publish one accessory per helper switch of the given A/C device, plus the
   * swing slider accessory (see `switchAccessory.ts` / `swingAccessory.ts`).
   *
   * The controls used to be extra services of the A/C accessory, but the Apple
   * Home app labels every tile with the name of the accessory it belongs to, so
   * they were all displayed as the A/C name ("LG AC"). Giving each control its
   * own accessory makes the Home app show its own label.
   */
  private publishControlAccessories(accessory: PlatformAccessory, handler: IRMQTTPlatformAccessory): void {
    const device = accessory.context.device;
    const newAccessories: PlatformAccessory[] = [];

    /**
     * Restore (or create) the accessory of one control. A stable, per-device
     * unique UUID keeps the same HomeKit tile across restarts.
     */
    const controlAccessoryFor = (definition: SwitchDefinition, category: Categories): PlatformAccessory => {
      const uuid = this.api.hap.uuid.generate(`${device.UniqueId}:${definition.subtype}`);
      const existingAccessory = this.accessories.get(uuid);
      const controlAccessory = existingAccessory
        ?? new this.api.platformAccessory(definition.name, uuid, category);

      controlAccessory.context.device = device;

      if (!existingAccessory) {
        newAccessories.push(controlAccessory);
      }

      // Mark the control as discovered, so it is not removed as an orphan below.
      this.discoveredCacheUUIDs.push(uuid);
      return controlAccessory;
    };

    for (const definition of handler.getSwitchDefinitions()) {
      const controlAccessory = controlAccessoryFor(definition, Categories.SWITCH);
      new IRMQTTSwitchAccessory(this, controlAccessory, handler, definition);
      this.log.info('Publishing switch accessory:', controlAccessory.displayName);
    }

    const sliderDefinition = handler.getSwingSliderDefinition();
    if (sliderDefinition) {
      const controlAccessory = controlAccessoryFor(sliderDefinition, Categories.FAN);
      new IRMQTTSwingSliderAccessory(this, controlAccessory, handler, sliderDefinition);
      this.log.info('Publishing swing slider accessory:', controlAccessory.displayName);
    }

    if (newAccessories.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
    }
  }
}
