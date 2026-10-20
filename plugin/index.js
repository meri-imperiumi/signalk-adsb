const { version, homepage } = require('../package.json');

// Both services reject generic user agents and ask for contact info
const USER_AGENT = `signalk-adsb/${version} (+${homepage})`;

// Free ADS-B networks with the readsb JSON format. Both are fed by the same
// community receivers, so their data is nearly identical: one is used at a
// time, and the other only stands in while the first one is failing.
const SERVICES = {
  'adsb.fi': {
    url: (lat, lon, radius) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radius}`,
    list: (data) => data.aircraft,
    maxRadius: 250, // nautical miles, larger values answer HTTP 400
    minSpacing: 1000, // about 1 request per second
  },
  'adsb.lol': {
    url: (lat, lon, radius) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`,
    list: (data) => data.ac,
    maxRadius: 500,
    // Its RateLimit headers allow 500 requests a day
    minSpacing: Math.ceil(86400000 / 500),
  },
};
const RADIUS_OPTIONS = [25, 50, 100, 200, 250, 500];
// While the local receiver heard an aircraft this recently, its (fresher)
// position wins and the internet copy of that aircraft is not published.
const LOCAL_PRIORITY = 60 * 1000;
const MIN_BACKOFF = 60 * 1000;
const MAX_BACKOFF = 15 * 60 * 1000;

function cleanFlight(flight) {
  return typeof flight === 'string' ? flight.replace(/\s/g, '') : '';
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// dump1090 data.json: altitude in ft, speed in kt, track in degrees
function fromDump1090(adsb) {
  return {
    hex: adsb.hex,
    flight: cleanFlight(adsb.flight),
    lat: toNumber(adsb.lat),
    lon: toNumber(adsb.lon),
    altitude: toNumber(adsb.altitude),
    speed: toNumber(adsb.speed),
    track: toNumber(adsb.track),
    squawk: adsb.squawk,
  };
}

// readsb `now` is in seconds (dump1090-fa, readsb, adsb.fi) or milliseconds (adsb.lol)
function nowMillis(now) {
  const n = toNumber(now);
  if (n === undefined) {
    return Date.now();
  }
  return n > 1e11 ? n : n * 1000;
}

// readsb format (dump1090-fa, readsb, adsb.fi, adsb.lol): alt_baro is ft or
// the string "ground", gs in kt, seen_pos = seconds since the position fix
function fromReadsb(ac, now) {
  let altitude = toNumber(ac.alt_baro);
  if (ac.alt_baro === 'ground') {
    altitude = 0;
  } else if (altitude === undefined) {
    altitude = toNumber(ac.alt_geom);
  }
  return {
    hex: ac.hex,
    flight: cleanFlight(ac.flight),
    lat: toNumber(ac.lat),
    lon: toNumber(ac.lon),
    altitude,
    speed: toNumber(ac.gs),
    track: toNumber(ac.track),
    squawk: ac.squawk,
    time: toNumber(ac.seen_pos) !== undefined ? now - ac.seen_pos * 1000 : now,
  };
}

function toValues(aircraft) {
  const position = {
    latitude: aircraft.lat,
    longitude: aircraft.lon,
  };
  if (aircraft.altitude !== undefined) {
    position.altitude = aircraft.altitude * 0.3048; // Convert from ft to m
  }
  const values = [
    {
      path: '',
      value: {
        name: aircraft.flight || aircraft.hex,
      },
    },
    {
      path: 'navigation.position',
      value: position,
    },
    {
      path: 'communication.icao.hex',
      value: aircraft.hex,
    },
  ];
  if (aircraft.speed !== undefined) {
    values.push({
      path: 'navigation.speedOverGround',
      value: aircraft.speed * 0.5144444, // Convert from kt to m/s
    });
  }
  if (aircraft.track !== undefined) {
    values.push({
      path: 'navigation.courseOverGroundTrue',
      value: aircraft.track * (Math.PI / 180),
    });
  }
  if (aircraft.flight) {
    values.push({
      path: 'communication.callsignVhf',
      value: aircraft.flight,
    });
  }
  if (aircraft.squawk) {
    values.push({
      path: 'communication.squawk',
      value: aircraft.squawk,
    });
  }
  return values;
}

class HttpError extends Error {
  constructor(status, retryAfter) {
    super(`Request failed with HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

module.exports = (app) => {
  const plugin = {};
  plugin.id = 'signalk-adsb';
  plugin.name = 'ADS-B';
  plugin.description = 'Receive aircraft via ADS-B into Signal K';
  let intervals = [];
  // Per internet service: when it was last asked, and until when to leave it alone
  let state = {};
  // Local receiver: when each aircraft (hex) was last heard
  let heardLocally = new Map();
  // Last status line of each poller ('local', 'internet'), shown together
  let statusParts = {};

  function serviceState(name) {
    if (!state[name]) {
      state[name] = { lastRequest: 0, backoffUntil: 0, failures: 0 };
    }
    return state[name];
  }

  function fetchJson(url, options) {
    return fetch(url, options)
      .then((response) => {
        if (!response.ok) {
          const header = response.headers && response.headers.get
            ? Number(response.headers.get('retry-after'))
            : NaN;
          throw new HttpError(response.status, Number.isFinite(header) ? header : undefined);
        }
        return response.json();
      });
  }

  function fetchDump1090(settings) {
    const host = settings.host || '127.0.0.1';
    const port = settings.port || 8080;
    return fetchJson(`http://${host}:${port}/dump1090/data.json`)
      .then((data) => ({
        aircraft: Array.isArray(data) ? data.map(fromDump1090) : [],
        src: `${host}:${port}`,
        via: 'via ADS-B',
      }));
  }

  // dump1090-fa and readsb write aircraft.json in the same format as the
  // internet services, with the position age in each record
  function fetchReadsbLocal(settings) {
    const host = settings.host || '127.0.0.1';
    const port = settings.port || 8080;
    const path = settings.aircraftJsonPath || '/data/aircraft.json';
    return fetchJson(`http://${host}:${port}${path.startsWith('/') ? '' : '/'}${path}`)
      .then((data) => {
        const now = nowMillis(data && data.now);
        return {
          aircraft: data && Array.isArray(data.aircraft)
            ? data.aircraft.map((ac) => fromReadsb(ac, now))
            : [],
          src: `${host}:${port}`,
          via: 'via ADS-B',
        };
      });
  }

  function backOff(name, err) {
    const s = serviceState(name);
    s.failures += 1;
    let delay = Math.min(MIN_BACKOFF * 2 ** (s.failures - 1), MAX_BACKOFF);
    if (err.retryAfter !== undefined) {
      delay = Math.max(delay, err.retryAfter * 1000);
    }
    s.backoffUntil = Date.now() + delay;
  }

  function requestService(name, settings, position) {
    const service = SERVICES[name];
    const s = serviceState(name);
    s.lastRequest = Date.now();
    const radius = Math.min(Math.max(Math.round(settings.radius || 50), 1), service.maxRadius);
    const url = service.url(position.latitude.toFixed(3), position.longitude.toFixed(3), radius);
    return fetchJson(url, { headers: { 'User-Agent': USER_AGENT } })
      .then((data) => {
        s.failures = 0;
        s.backoffUntil = 0;
        const list = data ? service.list(data) : undefined;
        const now = nowMillis(data && data.now);
        return {
          aircraft: Array.isArray(list) ? list.map((ac) => fromReadsb(ac, now)) : [],
          src: name,
          via: `from ${name} within ${radius} NM`,
        };
      });
  }

  // Which service to ask now: the selected one unless it is backing off,
  // else the other one when fallback is enabled. Each service is only asked
  // as often as its own limits allow, so a slow one may skip a cycle.
  function pickService(settings) {
    const now = Date.now();
    const primary = SERVICES[settings.source] ? settings.source : (settings.internetService || 'adsb.fi');
    const candidates = [primary];
    if (settings.fallback !== false) {
      candidates.push(...Object.keys(SERVICES).filter((n) => n !== primary));
    }
    const available = candidates.filter((n) => serviceState(n).backoffUntil <= now);
    if (!available.length) {
      return { wait: 'all services are backing off after errors' };
    }
    const name = available[0];
    if (now - serviceState(name).lastRequest < SERVICES[name].minSpacing) {
      return { skip: true };
    }
    return { name, primary };
  }

  function fetchInternet(settings) {
    const own = app.getSelfPath('navigation.position');
    const position = own && own.value ? own.value : own;
    if (!position
      || toNumber(position.latitude) === undefined
      || toNumber(position.longitude) === undefined) {
      return Promise.resolve({ status: 'Waiting for own vessel position' });
    }
    const pick = pickService(settings);
    if (pick.skip) {
      return Promise.resolve(null);
    }
    if (pick.wait) {
      return Promise.resolve({ error: `Not fetching aircraft: ${pick.wait}` });
    }
    return requestService(pick.name, settings, position)
      .then((result) => {
        if (pick.name !== pick.primary) {
          return { ...result, via: `${result.via} (${pick.primary} unavailable)` };
        }
        return result;
      })
      .catch((err) => {
        backOff(pick.name, err);
        throw err;
      });
  }

  function isLocal(settings) {
    return !settings.source || settings.source === 'dump1090' || settings.source === 'readsb';
  }

  // With a local receiver plus the internet, both pollers report together.
  // An internet failure then only shows in the status: the receiver still works.
  function report(kind, settings, message, isError) {
    const combined = isLocal(settings) && settings.internetSupplement === true;
    if (!combined) {
      if (isError) {
        app.setPluginError(message);
      } else {
        app.setPluginStatus(message);
      }
      return;
    }
    if (isError && kind === 'local') {
      app.setPluginError(message);
      return;
    }
    statusParts[kind] = message;
    app.setPluginStatus([statusParts.local, statusParts.internet].filter(Boolean).join(' · '));
  }

  // kind: 'local' or 'internet'; by default whatever `source` selects
  function poll(settings, kind = isLocal(settings) ? 'local' : 'internet') {
    let request;
    if (kind === 'internet') {
      request = fetchInternet(settings);
    } else if (settings.source === 'readsb') {
      request = fetchReadsbLocal(settings);
    } else {
      request = fetchDump1090(settings);
    }
    return request
      .then((result) => {
        if (!result) {
          return;
        }
        if (result.status) {
          report(kind, settings, result.status, false);
          return;
        }
        if (result.error) {
          report(kind, settings, result.error, true);
          return;
        }
        app.debug(result);
        const now = Date.now();
        // Aircraft without a position fix can't be shown on a chart
        let aircraft = result.aircraft
          .filter((a) => a.hex && a.lat !== undefined && a.lon !== undefined);
        if (kind === 'local') {
          aircraft.forEach((a) => heardLocally.set(a.hex, now));
        } else if (isLocal(settings)) {
          // Supplementing a local receiver: keep its fresher positions
          aircraft = aircraft
            .filter((a) => now - (heardLocally.get(a.hex) || 0) >= LOCAL_PRIORITY);
        }
        if (!aircraft.length) {
          report(kind, settings, `Not receiving aircraft ${result.via}`, false);
          return;
        }
        aircraft.forEach((a) => {
          app.handleMessage('signalk-adsb', {
            context: `aircraft.urn:mrn:icao:hex:${a.hex}`,
            updates: [
              {
                source: {
                  label: 'signalk-adsb',
                  src: result.src,
                },
                timestamp: new Date(a.time || Date.now()).toISOString(),
                values: toValues(a),
              },
            ],
          });
        });
        report(kind, settings, `Receiving ${aircraft.length} aircraft ${result.via}`, false);
      })
      .catch((err) => {
        app.debug(err);
        report(kind, settings, err.message, true);
      });
  }

  plugin.start = (settings) => {
    state = {};
    heardLocally = new Map();
    statusParts = {};
    if (isLocal(settings)) {
      intervals.push(setInterval(() => poll(settings, 'local'), (settings.interval || 10) * 1000));
    }
    if (!isLocal(settings) || settings.internetSupplement === true) {
      intervals.push(setInterval(() => poll(settings, 'internet'), (settings.internetInterval || 30) * 1000));
    }
  };

  plugin.stop = () => {
    intervals.forEach((i) => clearInterval(i));
    intervals = [];
  };

  // Exposed for tests
  plugin.poll = poll;

  plugin.schema = {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['dump1090', 'readsb', 'adsb.fi', 'adsb.lol'],
        enumNames: [
          'Local receiver: dump1090 (data.json)',
          'Local receiver: dump1090-fa or readsb (aircraft.json)',
          'Internet: adsb.fi',
          'Internet: adsb.lol',
        ],
        default: 'dump1090',
        title: 'Aircraft data source',
        description: 'Read a local ADS-B receiver, or fetch the aircraft around the vessel from a free ADS-B network (needs internet access and a position fix)',
      },
      host: {
        type: 'string',
        default: '127.0.0.1',
        title: 'Local receiver host',
        description: 'Address of the computer running dump1090, dump1090-fa or readsb',
      },
      port: {
        type: 'integer',
        default: 8080,
        title: 'Local receiver port',
        description: 'HTTP port of the receiver software',
      },
      aircraftJsonPath: {
        type: 'string',
        default: '/data/aircraft.json',
        title: 'Local receiver: aircraft.json path (dump1090-fa, readsb)',
        description: 'Usually /data/aircraft.json, /skyaware/data/aircraft.json (PiAware) or /tar1090/data/aircraft.json',
      },
      interval: {
        type: 'integer',
        default: 10,
        title: 'Local receiver polling interval (in seconds)',
        description: 'How often to fetch the data from the receiver',
      },
      radius: {
        type: 'integer',
        enum: RADIUS_OPTIONS,
        default: 50,
        title: 'Internet: radius around the vessel (in nautical miles)',
        description: 'adsb.fi serves up to 250 NM, so 500 NM only applies to adsb.lol. Chart plotters show the aircraft that fit on screen.',
      },
      internetInterval: {
        type: 'integer',
        default: 30,
        minimum: 5,
        title: 'Internet: refresh interval (in seconds)',
        description: 'How often to fetch the aircraft from the internet. adsb.lol allows 500 requests a day, so it is never asked more often than every 173 seconds.',
      },
      internetSupplement: {
        type: 'boolean',
        default: false,
        title: 'Local receiver: also fetch aircraft from the internet',
        description: 'Adds the aircraft beyond the receiver\'s range from the internet service below. Aircraft the receiver hears keep its fresher positions.',
      },
      internetService: {
        type: 'string',
        enum: ['adsb.fi', 'adsb.lol'],
        default: 'adsb.fi',
        title: 'Local receiver: internet service to add',
        description: 'Used with "also fetch aircraft from the internet"',
      },
      fallback: {
        type: 'boolean',
        default: true,
        title: 'Internet: use the other service while the selected one fails',
        description: 'Both services carry nearly the same aircraft, so the other one can stand in for a while',
      },
    },
  };

  return plugin;
};
