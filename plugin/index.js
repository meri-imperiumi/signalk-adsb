module.exports = (app) => {
  const plugin = {};
  plugin.id = 'signalk-adsb';
  plugin.name = 'ADS-B';
  plugin.description = 'Receive aircraft via ADS-B into Signal K';
  let interval;

  plugin.start = (settings) => {
    interval = setInterval(() => {
      fetch(`http://${settings.host}:${settings.port}/dump1090/data.json`)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Request failed with HTTP ${response.status}`);
          }
          return response.json();
        })
        .then((data) => {
          app.debug(data);
          if (!data || !data.length) {
            app.setPluginStatus('Not receiving aircraft via ADS-B');
            return;
          }
          data.forEach((adsb) => {
            const context = `aircraft.urn:mrn:icao:hex:${adsb.hex}`;

            const values = [
              {
                path: '',
                value: {
                  name: adsb.flight || adsb.hex,
                },
              },
              {
                path: 'navigation.position',
                value: {
                  latitude: adsb.lat,
                  longitude: adsb.lon,
                  altitude: adsb.altitude * 0.3048, // Convert from ft to m
                },
              },
              {
                path: 'navigation.speedOverGround',
                value: adsb.speed * 0.5144444, // Convert from kt to m/s
              },
              {
                path: 'navigation.courseOverGroundTrue',
                value: adsb.track * (Math.PI / 180),
              },
              {
                path: 'communication.icao.hex',
                value: adsb.hex, // Convert from kt to m/s
              },
              {
                path: 'communication.callsignVhf',
                value: adsb.flight, // Convert from kt to m/s
              },
            ];
            app.handleMessage('signalk-adsb', {
              context,
              updates: [
                {
                  source: {
                    label: 'signalk-adsb',
                    src: `${settings.host}:${settings.port}`,
                  },
                  timestamp: new Date().toISOString(),
                  values,
                },
              ],
            });
          });
          app.setPluginStatus(`Receiving ${data.length} aircraft via ADS-B`);
        })
        .catch((err) => {
          app.debug(err);
          app.setPluginError(err.message);
        });
    }, settings.interval * 1000);
  };

  plugin.stop = () => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  plugin.schema = {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        default: '127.0.0.1',
        title: 'dump1090 host',
        description: 'Address of the computer running dump1090',
      },
      port: {
        type: 'integer',
        default: 8080,
        title: 'dump1090 port',
        description: 'Port used for dump1090',
      },
      interval: {
        type: 'integer',
        default: 10,
        title: 'Polling interval (in seconds)',
        description: 'How often to fetch the data from dump1090',
      },
    },
  };

  return plugin;
};
