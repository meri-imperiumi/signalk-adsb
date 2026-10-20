Receive aircraft via ADS-B into Signal K
========================================

This plugin reads ADS-B aircraft data into Signal K, either from a local receiver running [dump1090](https://github.com/antirez/dump1090), [dump1090-fa](https://github.com/flightaware/dump1090) (PiAware) or [readsb](https://github.com/wiedehopf/readsb), or over the internet from the free [adsb.fi](https://adsb.fi) and [adsb.lol](https://adsb.lol) networks.

## Getting started

### With a local receiver

* Get an [RTL-SDR stick](https://www.rtl-sdr.com/about-rtl-sdr/) with [antenna suitable for 1090MHz](https://lucsmall.com/2017/02/06/making-antennas-for-1090mhz-ads-b-aircraft-tracking/) and plug it into a computer
* Install and run dump1090 with the `-net` option, or dump1090-fa / readsb (as installed by PiAware, the Flightradar24 feeder or adsb.im)
* Install and enable this plugin, and pick the matching data source
  - "dump1090 (data.json)" for the original dump1090
  - "dump1090-fa or readsb (aircraft.json)" for the others; set the path to `aircraft.json` if it isn't the default `/data/aircraft.json` (PiAware also serves it as `/skyaware/data/aircraft.json`, tar1090 as `/tar1090/data/aircraft.json`)
  - If the receiver software runs on a different computer than Signal K, configure its IP address and port accordingly
  - (optional) Enable "also fetch aircraft from the internet" to add the aircraft beyond the receiver's range from adsb.fi or adsb.lol. While the receiver hears an aircraft, its own fresher position is used and the internet copy is skipped; an aircraft it has not heard for a minute is taken from the internet.
* (optional) Enable display of aircraft in Freeboard

### Without a receiver, over the internet

* Install and enable this plugin, and set the data source to "Internet: adsb.fi" or "Internet: adsb.lol"
* Choose the radius around the vessel to fetch aircraft for, and how often to refresh (30 seconds by default)
* (optional) Enable display of aircraft in Freeboard. It shows the aircraft that fit on screen, so a large radius lets you zoom out and still see traffic.

The plugin asks for the aircraft around the vessel's own position (`navigation.position`), so it needs a position fix and internet access. Both networks are fed by volunteers' receivers, so coverage depends on the area. They carry nearly the same aircraft, so only one is used at a time. With "use the other service while the selected one fails" enabled (the default), the other one stands in while the selected one returns errors. A service that fails or answers HTTP 429 is left alone for a while (honouring `Retry-After`), starting at a minute and doubling up to 15 minutes.

| | adsb.fi | adsb.lol |
| --- | --- | --- |
| Radius | up to 250 NM | up to 500 NM |
| Request rate | about 1 per second | 500 per day, so the plugin asks it at most every 173 seconds |
| Terms | personal, non-commercial use, with attribution | [ODbL](https://opendatacommons.org/licenses/odbl/summary/) licensed data |

With aircraft.json and the internet sources, each aircraft is stamped with the time of its last position fix (`seen_pos`), so chart plotters can grey out targets that are no longer heard.

A request covering 500 NM returns several hundred aircraft (around 80 kB compressed), which is worth keeping in mind on metered connections.

![Aircraft approaching SKCG as seen on Freeboard](https://github.com/meri-imperiumi/signalk-adsb/raw/main/doc/freeboard.png)

## Changes

See [Changelog](CHANGELOG.md)
