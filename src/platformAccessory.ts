import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

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
  private acstate = {
    On: false,
    Mode: 3, // 0: Off, 1: Heat, 2: Cool, 3: Auto, 4: Fan
    TargetMode: 2,
    TargetTemp: 22,
    rotationSpeed: 1
  };


  constructor(
    private readonly platform: IRMQTTHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'AC')
      .setCharacteristic(this.platform.Characteristic.Model, 'IRMQTT-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'XX6657');


    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) || this.accessory.addService(this.platform.Service.HeaterCooler);


    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this)) // SET - bind to the `setOn` method below
      .onGet(this.getActive.bind(this)); // GET - bind to the `getOn` method below


    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.handleCurrentHeaterCoolerStateGet.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE,
          this.platform.Characteristic.CurrentHeaterCoolerState.IDLE,
          this.platform.Characteristic.CurrentHeaterCoolerState.COOLING
        ]
      });

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.handleTargetHeaterCoolerStateGet.bind(this))
      .onSet(this.handleTargetHeaterCoolerStateSet.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
          this.platform.Characteristic.TargetHeaterCoolerState.COOL]
      });


    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.handleRotationSpeedGet.bind(this))
      .onSet(this.handleRotationSpeedSet.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 10,
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

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setActive(value: CharacteristicValue) {
    // implement your own code to turn your device on/off

    this.acstate.On = value as boolean;

    this.platform.log.debug('Set Characteristic On ->', value);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.
   * In this case, you may decide not to implement `onGet` handlers, which may speed up
   * the responsiveness of your device in the Home app.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getActive(): Promise<CharacteristicValue> {
    // implement your own code to check if the device is on
    const isOn = this.acstate.On;

    this.platform.log.debug('Get Characteristic On ->', isOn);

    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    return isOn;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Mode
   */
  async handleCurrentHeaterCoolerStateGet(value: CharacteristicValue) {
    // implement your own code to set the Mode

    this.acstate.Mode = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;

    this.platform.log.debug('Set Characteristic Mode -> ', value);

    return this.acstate.Mode;
  }  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Mode
   */
  async handleTargetHeaterCoolerStateSet(value: CharacteristicValue) {
    // implement your own code to set the Mode

    this.acstate.TargetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;

    this.platform.log.debug('Set Characteristic Mode -> ', value);
    
  }
  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  async handleTargetHeaterCoolerStateGet(value: CharacteristicValue) {
    // implement your own code to set the Mode

    this.acstate.TargetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;

    this.platform.log.debug('Set Characteristic Mode -> ', value);

    return this.acstate.TargetMode
  }
  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Mode
   */
  async handleCurrentTemperatureGet(value: CharacteristicValue) {
    // implement your own code to set the Mode

    this.acstate.Mode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;

    this.platform.log.debug('Set Characteristic Mode -> ', value);
    return Math.random() * 20 + 16; // Return a random temperature between 10 and 40 degrees Celsius
  }

  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  async handleCoolingThresholdTemperatureGet(value: CharacteristicValue) {
    // implement your own code to set the Mode

    this.acstate.TargetTemp = Math.floor(Math.random() * (30 - 17 + 1)) + 17;

    this.platform.log.debug('Set Characteristic Mode -> ', value);
    return this.acstate.TargetTemp;
  }

  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  async handleCoolingThresholdTemperatureSet(value: CharacteristicValue) {
    // implement your own code to set the Mode

    this.acstate.TargetTemp = Math.floor(Math.random() * (30 - 17 + 1)) + 17;

    this.platform.log.debug('Set Characteristic Mode -> ', value);

  }

  /**
* Handle "SET" requests from HomeKit
* These are sent when the user changes the state of an accessory, for example, changing the Mode
*/
  async handleRotationSpeedGet(value: CharacteristicValue) {
    // implement your own code to set the Mode

    this.acstate.rotationSpeed = Math.floor(Math.random() * 10) + 1;

    this.platform.log.debug('Set Characteristic Mode -> ', value);
    return this.acstate.rotationSpeed;
  }

  /**
  * Handle "SET" requests from HomeKit
  * These are sent when the user changes the state of an accessory, for example, changing the Mode
  */
  async handleRotationSpeedSet(value: CharacteristicValue) {
    // implement your own code to set the Mode

    this.acstate.rotationSpeed = Math.floor(Math.random() * 10) + 1;

    this.platform.log.debug('Set Characteristic Mode -> ', value);

  }
}
