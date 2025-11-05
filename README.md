Receive aircraft via ADS-B into Signal K
========================================

This plugin reads ADS-B aircraft data received using the [dump1090 software](https://github.com/antirez/dump1090) into Signal K.

## Getting started

* Get an [RTL-SDR stick](https://www.rtl-sdr.com/about-rtl-sdr/) with [antenna suitable for 1090MHz](https://lucsmall.com/2017/02/06/making-antennas-for-1090mhz-ads-b-aircraft-tracking/) and plug it into a computer
* Install and run dump1090 with the `-net` option
* Install and enable this plugin
  - If dump1090 is running on a different computer than Signal K, configure the IP address used in the plugin accordingly
* (optional) Enable display of aircraft in Freeboard

![Aircraft approaching SKCG as seen on Freeboard](https://github.com/meri-imperiumi/signalk-adsb/raw/main/doc/freeboard.png)

## Changes

* 1.0.0 (2025-11-05)
  - Initial release
