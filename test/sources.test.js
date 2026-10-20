const {
  describe, it, beforeEach, afterEach,
} = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../plugin/index');

const OWN = { value: { latitude: 38.9812, longitude: 1.5304 } };

function makeApp(position) {
  const app = {
    messages: [],
    status: null,
    pluginError: null,
    debug: () => {},
    error: () => {},
    getSelfPath: () => position,
    handleMessage: (id, delta) => app.messages.push(delta),
    setPluginStatus: (msg) => { app.status = msg; },
    setPluginError: (msg) => { app.pluginError = msg; },
  };
  return app;
}

function valueOf(delta, path) {
  const found = delta.updates[0].values.find((v) => v.path === path);
  return found ? found.value : undefined;
}

describe('aircraft sources', () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  let requests;
  let clock;

  // responder(url) returns { status, body, headers } for each request
  function mockFetch(responder) {
    global.fetch = (url, options) => {
      requests.push({ url, options });
      const { status = 200, body = {}, headers = {} } = responder(url);
      return Promise.resolve({
        ok: status === 200,
        status,
        headers: { get: (name) => headers[name.toLowerCase()] },
        json: () => Promise.resolve(body),
      });
    };
  }

  beforeEach(() => {
    requests = [];
    clock = 1000000000000;
    Date.now = () => clock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Date.now = originalNow;
  });

  it('reads dump1090 data.json by default', async () => {
    mockFetch(() => ({
      body: [
        {
          hex: '4ca7b5', flight: 'RYR12AB ', lat: 38.9, lon: 1.4, altitude: 10000, speed: 300, track: 90, squawk: '2000',
        },
      ],
    }));
    const app = makeApp();
    await pluginFactory(app).poll({ host: '10.0.0.5', port: 8080 });
    assert.deepEqual(requests.map((r) => r.url), ['http://10.0.0.5:8080/dump1090/data.json']);
    assert.equal(app.messages.length, 1);
    const delta = app.messages[0];
    assert.equal(delta.context, 'aircraft.urn:mrn:icao:hex:4ca7b5');
    assert.deepEqual(valueOf(delta, ''), { name: 'RYR12AB' });
    assert.equal(valueOf(delta, 'navigation.position').altitude, 3048);
    assert.ok(Math.abs(valueOf(delta, 'navigation.speedOverGround') - 154.33) < 0.01);
    assert.ok(Math.abs(valueOf(delta, 'navigation.courseOverGroundTrue') - Math.PI / 2) < 1e-9);
    assert.equal(valueOf(delta, 'communication.callsignVhf'), 'RYR12AB');
    assert.equal(app.status, 'Receiving 1 aircraft via ADS-B');
  });

  it('does not fail the whole batch on an aircraft without callsign', async () => {
    mockFetch(() => ({
      body: [
        {
          hex: 'aaaaaa', lat: 38.9, lon: 1.4, altitude: 5000, speed: 200, track: 10,
        },
        {
          hex: 'bbbbbb', flight: 'IBE1 ', lat: 39.0, lon: 1.5, altitude: 6000, speed: 210, track: 20,
        },
      ],
    }));
    const app = makeApp();
    await pluginFactory(app).poll({});
    assert.equal(app.pluginError, null);
    assert.equal(app.messages.length, 2);
    assert.deepEqual(valueOf(app.messages[0], ''), { name: 'aaaaaa' });
    assert.equal(valueOf(app.messages[0], 'communication.callsignVhf'), undefined);
  });

  it('fetches adsb.fi around the vessel position', async () => {
    mockFetch(() => ({
      body: {
        aircraft: [
          {
            hex: '346182', flight: 'ANE70JF ', lat: 38.71, lon: 1.653, alt_baro: 9975, gs: 274, track: 66.33, squawk: '6315',
          },
          {
            hex: '3443c1', flight: 'VLG2AB  ', lat: 38.87, lon: 1.37, alt_baro: 'ground', gs: 12, track: 240,
          },
          // No position fix: skipped
          { hex: '345000', flight: 'NOPOS' },
        ],
      },
    }));
    const app = makeApp(OWN);
    await pluginFactory(app).poll({ source: 'adsb.fi', radius: 100 });
    assert.deepEqual(requests.map((r) => r.url), ['https://opendata.adsb.fi/api/v2/lat/38.981/lon/1.530/dist/100']);
    // Both services answer 403 to generic user agents
    assert.match(requests[0].options.headers['User-Agent'], /^signalk-adsb\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/meri-imperiumi\/signalk-adsb/);
    assert.equal(app.messages.length, 2);
    assert.equal(app.messages[0].updates[0].source.src, 'adsb.fi');
    assert.ok(Math.abs(valueOf(app.messages[0], 'navigation.position').altitude - 3040.38) < 0.01);
    assert.equal(valueOf(app.messages[1], 'navigation.position').altitude, 0);
    assert.equal(app.status, 'Receiving 2 aircraft from adsb.fi within 100 NM');
  });

  it('caps the radius at what each service serves', async () => {
    mockFetch(() => ({ body: { aircraft: [], ac: [] } }));
    const app = makeApp(OWN);
    await pluginFactory(app).poll({ source: 'adsb.fi', radius: 500 });
    await pluginFactory(app).poll({ source: 'adsb.lol', radius: 500 });
    assert.deepEqual(requests.map((r) => r.url), [
      'https://opendata.adsb.fi/api/v2/lat/38.981/lon/1.530/dist/250',
      'https://api.adsb.lol/v2/point/38.981/1.530/500',
    ]);
    assert.equal(app.status, 'Not receiving aircraft from adsb.lol within 500 NM');
  });

  it('asks adsb.lol at most every 173 seconds', async () => {
    mockFetch(() => ({ body: { ac: [] } }));
    const app = makeApp(OWN);
    const plugin = pluginFactory(app);
    await plugin.poll({ source: 'adsb.lol' });
    clock += 30 * 1000;
    await plugin.poll({ source: 'adsb.lol' });
    clock += 150 * 1000;
    await plugin.poll({ source: 'adsb.lol' });
    assert.equal(requests.length, 2);
  });

  it('falls back to the other service while the selected one fails', async () => {
    let fiDown = true;
    mockFetch((url) => {
      if (url.includes('adsb.fi')) {
        return fiDown ? { status: 503 } : { body: { aircraft: [] } };
      }
      return {
        body: {
          ac: [{
            hex: '346182', flight: 'ANE70JF', lat: 38.71, lon: 1.653, alt_baro: 9975,
          }],
        },
      };
    });
    const app = makeApp(OWN);
    const plugin = pluginFactory(app);
    const settings = { source: 'adsb.fi' };

    await plugin.poll(settings);
    assert.equal(app.pluginError, 'Request failed with HTTP 503');

    clock += 30 * 1000;
    await plugin.poll(settings);
    assert.equal(app.status, 'Receiving 1 aircraft from adsb.lol within 50 NM (adsb.fi unavailable)');

    // adsb.fi backs off for a minute; adsb.lol may not be asked again yet
    clock += 20 * 1000;
    await plugin.poll(settings);
    assert.equal(requests.length, 2);

    // Once the back-off is over, adsb.fi is used again
    fiDown = false;
    clock += 30 * 1000;
    await plugin.poll(settings);
    assert.deepEqual(requests.map((r) => new URL(r.url).host), [
      'opendata.adsb.fi', 'api.adsb.lol', 'opendata.adsb.fi',
    ]);
    assert.equal(app.status, 'Not receiving aircraft from adsb.fi within 50 NM');
  });

  it('respects Retry-After and does not fall back when disabled', async () => {
    mockFetch(() => ({ status: 429, headers: { 'retry-after': '600' } }));
    const app = makeApp(OWN);
    const plugin = pluginFactory(app);
    const settings = { source: 'adsb.fi', fallback: false };

    await plugin.poll(settings);
    assert.equal(app.pluginError, 'Request failed with HTTP 429');

    clock += 5 * 60 * 1000;
    await plugin.poll(settings);
    assert.equal(app.pluginError, 'Not fetching aircraft: all services are backing off after errors');
    assert.equal(requests.length, 1);

    clock += 6 * 60 * 1000;
    await plugin.poll(settings);
    assert.equal(requests.length, 2);
  });

  it('reads aircraft.json from dump1090-fa or readsb', async () => {
    mockFetch(() => ({
      body: {
        now: 1792422166.3,
        aircraft: [
          {
            hex: '342189', flight: 'IBE3456 ', lat: 37.9, lon: -3.6, alt_baro: 24625, gs: 422.6, track: 30, seen_pos: 2.3,
          },
          // Heard, but no position yet
          { hex: '3c4b26', alt_baro: 36000 },
        ],
      },
    }));
    const app = makeApp();
    await pluginFactory(app).poll({
      source: 'readsb', host: '10.0.0.7', port: 8080, aircraftJsonPath: 'skyaware/data/aircraft.json',
    });
    assert.deepEqual(requests.map((r) => r.url), ['http://10.0.0.7:8080/skyaware/data/aircraft.json']);
    assert.equal(app.messages.length, 1);
    assert.equal(app.messages[0].updates[0].source.src, '10.0.0.7:8080');
    assert.equal(app.status, 'Receiving 1 aircraft via ADS-B');
  });

  it('stamps each aircraft with the time of its position fix', async () => {
    mockFetch((url) => (url.includes('aircraft.json')
      ? {
        body: {
          now: 1792422166.3,
          aircraft: [{
            hex: 'aaaaaa', lat: 38, lon: -3, seen_pos: 40,
          }],
        },
      }
      : { body: { now: 1792422166300, ac: [{ hex: 'bbbbbb', lat: 38, lon: 1 }] } }));
    const app = makeApp(OWN);
    await pluginFactory(app).poll({ source: 'readsb' });
    await pluginFactory(app).poll({ source: 'adsb.lol' });
    assert.equal(app.messages[0].updates[0].timestamp, new Date(1792422126300).toISOString());
    // No seen_pos: the response time
    assert.equal(app.messages[1].updates[0].timestamp, new Date(1792422166300).toISOString());
  });

  it('adds internet aircraft to a local receiver, keeping the receiver\'s positions', async () => {
    mockFetch((url) => (url.includes('aircraft.json')
      ? {
        body: {
          now: 1792422166.3,
          aircraft: [{
            hex: 'aaaaaa', lat: 38, lon: -3, seen_pos: 1,
          }],
        },
      }
      : {
        body: {
          now: 1792422166.3,
          aircraft: [
            { hex: 'aaaaaa', lat: 38.1, lon: -3.1 },
            { hex: 'bbbbbb', lat: 39, lon: -2 },
          ],
        },
      }));
    const app = makeApp(OWN);
    const plugin = pluginFactory(app);
    const settings = { source: 'readsb', internetSupplement: true, internetService: 'adsb.fi' };

    await plugin.poll(settings, 'local');
    await plugin.poll(settings, 'internet');
    assert.deepEqual(app.messages.map((m) => [m.context, m.updates[0].source.src]), [
      ['aircraft.urn:mrn:icao:hex:aaaaaa', '127.0.0.1:8080'],
      ['aircraft.urn:mrn:icao:hex:bbbbbb', 'adsb.fi'],
    ]);
    assert.equal(app.status, 'Receiving 1 aircraft via ADS-B · Receiving 1 aircraft from adsb.fi within 50 NM');

    // Once the receiver has not heard it for a minute, the internet copy is used
    clock += 61 * 1000;
    await plugin.poll(settings, 'internet');
    assert.deepEqual(app.messages.slice(2).map((m) => m.context), [
      'aircraft.urn:mrn:icao:hex:aaaaaa',
      'aircraft.urn:mrn:icao:hex:bbbbbb',
    ]);
  });

  it('reports an internet failure without flagging the local receiver as failed', async () => {
    mockFetch((url) => (url.includes('aircraft.json')
      ? { body: { now: 1792422166.3, aircraft: [{ hex: 'aaaaaa', lat: 38, lon: -3 }] } }
      : { status: 503 }));
    const app = makeApp(OWN);
    const plugin = pluginFactory(app);
    const settings = {
      source: 'readsb', internetSupplement: true, internetService: 'adsb.fi', fallback: false,
    };

    await plugin.poll(settings, 'local');
    await plugin.poll(settings, 'internet');
    assert.equal(app.pluginError, null);
    assert.equal(app.status, 'Receiving 1 aircraft via ADS-B · Request failed with HTTP 503');
  });

  it('waits for the vessel position before using the internet', async () => {
    mockFetch(() => ({ body: { aircraft: [] } }));
    const app = makeApp(undefined);
    await pluginFactory(app).poll({ source: 'adsb.fi' });
    assert.deepEqual(requests, []);
    assert.equal(app.status, 'Waiting for own vessel position');
  });
});
