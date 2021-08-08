const defaultPollIntervalInSeconds = 15;
const minPollIntervalInSeconds = 2;

const distanceDataType = 'distance'
const temperatureDataType = 'ultrasound_sensor_temperature'
const pollIntervalDataType = 'poll_interval';

const zigbeeHerdsmanConverters = require('zigbee-herdsman-converters');
const globalStore = require('zigbee-herdsman-converters/lib/store');

const exposes = zigbeeHerdsmanConverters.exposes;
const ea = exposes.access;
const e = exposes.presets;
const fz = zigbeeHerdsmanConverters.fromZigbeeConverters;
const tz = zigbeeHerdsmanConverters.toZigbeeConverters;

const ptvo_switch = zigbeeHerdsmanConverters.findByDevice({modelID: 'ptvo.switch'});
fz.legacy = ptvo_switch.meta.tuyaThermostatPreset;

fz.legacy = require('zigbee-herdsman-converters/lib/legacy').fromZigbee

const requestValuesUpdate = async (device, valueType) => {
    const uartEndpointId = 4
    const endpoint = device.getEndpoint(uartEndpointId);

    const cluster = 'genMultistateValue';

    if (!endpoint.supportsInputCluster(cluster) && !endpoint.supportsOutputCluster(cluster)) {
        throw new Error(`Expected to have endpoint with id=${uartEndpointId} configured as UART one`);
    }

    const value = valueType === distanceDataType ? 'U' : 'P';

    const ZCL_DATATYPE_CHAR_STR = 0x42;
    const ZCL_DATATYPE_OCTET_STR = 0x41;

    const payloadDistance = {14: {value, type: ZCL_DATATYPE_CHAR_STR}};

    await endpoint.write(cluster, payloadDistance);
}

const custom_converters = {
    from_uart: {
        cluster: 'genMultistateValue',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {

            if (meta.state.hasOwnProperty('poll_interval')) {
                let pollingConfig = globalStore.getValue(meta.device, 'interval');
                pollingConfig.intervalInSeconds = meta.state.poll_interval;
            }

            let data = msg.data['stateText'];
            
            if (typeof data === 'object') {
                
                if (data.length === 1) {

                    let temperature = data[0] - 45;
                    return {'ultrasound_sensor_temperature': temperature};
                }
                
                if (data.length === 2) {
                    let distance = 256 * data[0] + data[1];

                    const maxDistance = 11000;
                    return {'distance': distance > maxDistance ? null :distance };
                }
                
                let bHex = false;
                let code;
                let index;
                for (index = 0; index < data.length; index += 1) {
                    code = data[index];
                    if ((code < 32) || (code > 127)) {
                        bHex = true;
                        break;
                    }
                }
                if (!bHex) {
                    data = data.toString('latin1');
                } else {
                    data = [...data];
                }
            }
            return {'action': data};
        },
    },
    to_uart: {
        key: [distanceDataType, temperatureDataType, pollIntervalDataType],
        convertGet: async (entity, key, meta) => {
            await requestValuesUpdate(meta.device, key);
        },
        convertSet: async (entity, key, value, meta) => {
            if(key !== pollIntervalDataType){
                return;
            }

            if (typeof value === 'string' && isNaN(value)) {
                throw new Error(`Invalid poll interval '${value}'`);
            }

            if (value < minPollIntervalInSeconds) {
                throw new Error(`Poll interval should be not less than ${minPollIntervalInSeconds} seconds but '${value}' second(s) provided`);
            }

            let pollingConfig = globalStore.getValue(entity.getDevice(), 'interval');
            pollingConfig.intervalInSeconds = value;

            return {state: {poll_interval: value}};
        },
    },
}

const sleepSeconds = async (s) => {
    return new Promise((resolve) => setTimeout(resolve, s * 1000));
};

const poll = async (device, pollingConfig) => {
    const delaySecondsToPollTemperature = 1;

    while(true) {
        if(pollingConfig.stop) {
            return;
        }
    
        try {
            await requestValuesUpdate(device, distanceDataType);
        } catch (error) {
            // device is lost, need to permit join
        }

        if(pollingConfig.stop) {
            return;
        }
        
        await sleepSeconds(delaySecondsToPollTemperature);

        if(pollingConfig.stop) {
            return;
        }
    
        try {
            await requestValuesUpdate(device, temperatureDataType);
        } catch (error) {
            // device is lost, need to permit join
        }

        if(pollingConfig.stop) {
            return;
        }

        await sleepSeconds(pollingConfig.intervalInSeconds - delaySecondsToPollTemperature);
    }
};

const device = {
    zigbeeModel: ['2ch.1curren.UART'],
    model: '2ch.1curren.UART',
    vendor: 'Custom devices (DiY)',
    description: '[2 channel relay + UART: first channel with current measurements](https://ptvo.info/zigbee-configurable-firmware-features/)',
    fromZigbee: [fz.ignore_basic_report, fz.ptvo_switch_analog_input, fz.on_off, fz.ptvo_switch_uart, custom_converters.from_uart, fz.ptvo_multistate_action, fz.legacy.ptvo_switch_buttons,],
    toZigbee: [tz.ptvo_switch_trigger, tz.ptvo_switch_analog_input, tz.on_off, tz.ptvo_switch_uart, custom_converters.to_uart,],
    exposes: [
        e.current().withAccess(ea.STATE).withEndpoint('l1'),
        e.switch().withEndpoint('l2'),
        //exposes.text('action', ea.ALL).withDescription('button clicks or data from/to UART'),
        exposes.numeric(temperatureDataType, ea.STATE_GET).withDescription(`Ultrasound sensor temperature`).withUnit('°C'),
        exposes.numeric(distanceDataType, ea.STATE_GET).withDescription(`Ultrasound sensor distance`).withUnit('mm'),
        exposes.numeric(pollIntervalDataType, ea.STATE_SET).withDescription(`Poll interval (minimum is ${minPollIntervalInSeconds} seconds)`).withUnit('seconds'),
        e.switch().withEndpoint('l6'),
        e.temperature().withEndpoint('l8'),
    ],
    meta: {
        multiEndpoint: true
    },
    endpoint: (device) => {
        return {
            l1: 1, l2: 2, l4: 4, action: 1, l6: 6, l8: 8, l5: 5,
        };
    },
    onEvent: async (type, data, device) => {
        if (type === 'stop') {
            let pollingConfig = globalStore.getValue(device, 'interval');
            pollingConfig.stop = true;

            if(pollingConfig.pollTimeout) {
                clearTimeout(pollingConfig.pollTimeout);
            }

            if(pollingConfig.temperaturePollTimeout) {
                clearTimeout(pollingConfig.temperaturePollTimeout);
            }

            globalStore.clearValue(device, 'interval');
        }
        if (['start', 'deviceAnnounce'].includes(type)) {
            
            if (!globalStore.hasValue(device, 'interval')) {
                let pollingConfig = {stop: false, intervalInSeconds: defaultPollIntervalInSeconds};
            
                globalStore.putValue(device, 'interval', pollingConfig);

                await poll(device, pollingConfig);
            }
        }
    },
};

module.exports = device;
