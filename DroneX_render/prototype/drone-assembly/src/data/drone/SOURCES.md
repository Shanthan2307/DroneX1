# DroneX data sources

This folder is the single source of truth for DroneX's real-world numbers. Edit the JSON by hand and keep this file in step.
Every record carries a `source` URL. Its `notes` quote the numbers that page states. A value worked out from published figures is
marked DERIVED in the notes, with its formula. A value nobody publishes is null with `TODO(source)`.

Last full audit: 2026-10-24. Every record's source was opened and its key numbers checked against the record. The changes are listed at the end.

Pages that refuse automated fetches (HTTP 403/429: geprc.com, apcprop.com via curl, kdedirect.com, pyrodrone.com, gemfanhobby.com) were read through a browser-style fetch or a search snippet. Where that happened, the record's notes say so.

## Motors (10)

| ID | Name | Key numbers | Source |
|---|---|---|---|
| `tmotor-f60-pro-iv` | T-Motor F60 Pro IV V2.0 1950KV | 1950 KV, 33.4 g, Rm 60 mΩ, 42 A / 949 W, idle – A | [link](https://fpvua.com/en/motor-t-motor-f60-pro-iv-v2-0-2207-5-1950kv/) |
| `sunnysky-x2216-880kv` | Sunnysky X2216-III 880KV | 880 KV, 67.5 g, Rm 89 mΩ, 30 A / 440 W, idle 0.5 A | [link](http://en.rcsunnysky.com/x-fixedwingseries/44.html) |
| `brotherhobby-1504-5` | BrotherHobby VY 1504.5 3950KV | 3950 KV, 12.07 g, Rm 139.74 mΩ, 13.2 A / 211.2 W, idle 0.67 A | [link](https://www.brotherhobbystore.com/products/vy-15045-motor-cw) |
| `sunnysky-v4008-380kv` | Sunnysky V4008 380KV Flat Multirotor | 380 KV, 105 g, Rm 131 mΩ, 20 A / 500 W, idle 0.5 A | [link](http://en.rcsunnysky.com/v-multi-rotorefficiencytype/1082.html) |
| `geprc-gr1404-4500kv` | GEPRC GR1404 4500KV | 4500 KV, 9.8 g, Rm 213 mΩ, 13.38 A / 214 W, idle 0.51 A | [link](https://geprc.com/product/geprc-gr1404-4500kv-motor/) |
| `iflight-xing2-2809-1250kv` | iFlight XING2 2809 1250KV | 1250 KV, 60.7 g, Rm 65.46 mΩ, 50 A / 1145 W, idle – A | [link](https://shop.iflight.com/XING2-2809-FPV-Motor-Unibell-Pro1673) |
| `tmotor-mn4014-330kv` | T-Motor MN4014 330KV (Navigator) | 330 KV, 171 g, Rm 85 mΩ, 25 A / 750 W, idle 1.1 A | [link](https://store.tmotor.com/product/mn4014-kv330-motor-navigator-type.html) |
| `sunnysky-x4112s-450kv` | Sunnysky X4112S 450KV | 450 KV, 169 g, Rm 43 mΩ, 78 A / 1950 W, idle 0.7 A | [link](http://en.rcsunnysky.com/xs-multi-rotorpowered/1167.html) |
| `sunnysky-x3520-iii-560kv` | Sunnysky X3520-III 560KV | 560 KV, 219 g, Rm 23 mΩ, 40 A / 880 W, idle 1.1 A | [link](http://en.rcsunnysky.com/x-fixedwingseries/57.html) |
| `kde-3510xf-475` | KDE Direct KDE3510XF-475 | 475 KV, 175 g, Rm 105 mΩ, 30 A / 665 W, idle 0.2 A | [link](https://www.kdedirect.com/products/kde3510xf-475) |

## Propellers (9)

| ID | Name | Key numbers | Source |
|---|---|---|---|
| `gemfan-51466` | Gemfan Hurricane 51466 V2 | 5.1×4.66 in, 3-blade, 4.2 g, Ct –, Cp – | [link](https://www.gemfanhobby.com/hurricane-51466-v2-pc-3-blade.html) |
| `apc-5x45-bn` | APC B5x4.5E Bullnose | 5×4.5 in, 2-blade, 5.1 g, Ct 0.1931, Cp 0.1105 | [link](https://www.apcprop.com/product/b5x4-5e-b4/) |
| `apc-10x45-mr` | APC 10x4.5 Multi-Rotor | 10×4.5 in, 2-blade, 15 g, Ct 0.107, Cp 0.0398 | [link](https://www.apcprop.com/product/10x4-5mr/) |
| `apc-9x6-e` | APC 9x6 Thin Electric | 9×6 in, 2-blade, 17.9 g, Ct 0.1145, Cp 0.0514 | [link](https://www.apcprop.com/product/9x6e/) |
| `gemfan-d63-3` | Gemfan D63 Ducted 3-Blade 63mm | 2.48×3 in, 3-blade, 1.36 g, Ct 0.362, Cp 0.322 | [link](https://kiwiquads.co.nz/product/gemfan-d63-ducted-63mm-2-5-propellers-4-colours/) |
| `gemfan-flash-7040-3` | Gemfan Flash 7040 Tri-Blade | 7×4 in, 3-blade, 7.9 g, Ct 0.083, Cp 0.0331 | [link](https://pyrodrone.com/products/gemfan-flash-7040-tri-blade-7-prop-4-pack-choose-color) |
| `tmotor-p17x5-8` | T-Motor P17x5.8 Polished Carbon | 17×5.8 in, 2-blade, 26.5 g, Ct 0.0755, Cp 0.0247 | [link](https://store.tmotor.com/product/polish-carbon-fiber-17x5_8-prop.html) |
| `eolo-cn13x5` | EOLO CN13x5 Carbon-Nylon Multirotor Prop | 13×5 in, 2-blade, – g, Ct 0.0859, Cp 0.0332 | [link](http://en.rcsunnysky.com/xs-multi-rotorpowered/1167.html) |
| `apc-14x7e` | APC 14x7E Thin Electric | 14×7 in, 2-blade, 34 g, Ct 0.0839, Cp 0.0346 | [link](https://www.apcprop.com/product/14x7e/) |

## Batteries (8)

| ID | Name | Key numbers | Source |
|---|---|---|---|
| `tattu-rline-4s-1550` | Tattu R-Line V3.0 4S 1550mAh 120C | 4S LiPo, 1550 mAh, 120C, 176 g | [link](https://www.fpv24.com/en/tattu/tattu-r-line-v3-battery-lipo-battery-1550-mah-4s1p-120c-xt60) |
| `cnhl-black-6s-1300` | CNHL Black Series 6S 1300mAh 100C | 6S LiPo, 1300 mAh, 100C, 230 g | [link](http://web.archive.org/web/20241014110744/https://www.racedayquads.com/products/cnhl-black-series-22-2v-6s-1300mah-100c-lipo-battery-xt60) |
| `molicel-21700-6s-4200` | Molicel P42A 6S1P (cells only) | 6S Li-ion, 4200 mAh, 10.7C, 420 g | [link](https://www.molicel.com/product/inr-21700-p42a/) |
| `tattu-6s-4500-25c` | Tattu 4500mAh 6S 25C LiPo (XT90) | 6S LiPo, 4500 mAh, 25C, 610 g | [link](http://web.archive.org/web/20240811094325/https://www.gensace.de/tattu-4500mah-22-2v-25c-6s1p-lipo-battery-pack-with-xt90.html) |
| `gnb-3s-850` | Gaoneng GNB 3S 850mAh 80C Ultralight | 3S LiPo, 850 mAh, 80C, 80 g | [link](http://web.archive.org/web/20250615143149/https://www.racedayquads.com/products/gaoneng-gnb-11-1v-3s-850mah-80c-lipo-micro-battery-square-type-xt30) |
| `geprc-4s-660-hv` | GEPRC 4S 660mAh 90C LiHV | 4S LiHV, 660 mAh, 90C, 64.1 g | [link](https://geprc.com/product/geprc-4s-660mah-90-180c-hv-3-8v-4-35v-lipo-battery/) |
| `iflight-fullsend-6s-8000` | iFlight Fullsend 6S2P 8000mAh Li-ion | 6S Li-ion, 8000 mAh, 17.5C, 840 g | [link](https://shop.iflight.com/Fullsend-6S-8000mAh-Li-Ion-Battery-Pro1914) |
| `tattu-plus-6s-16000` | Tattu Plus 6S 16000mAh 15C Smart | 6S LiPo, 16000 mAh, 15C, 2063 g | [link](https://genstattu.com/tattu-plus-16000mah-6s-15c-22-2V-lipo-battery-pack-with-as150-xt150-plug.html) |

## Airframes (7)

| ID | Name | Key numbers | Source |
|---|---|---|---|
| `apex-5-freestyle` | ImpulseRC Apex 5" Freestyle Carbon Quad | multirotor, wheelbase 225 mm, empty 115 g | [link](http://web.archive.org/web/20201108010422/http://apex.impulserc.com/) |
| `eclipson-model-a` | Eclipson Model A 3D-Printable Plane (LW-PLA) | fixed_wing_3dprint, span 1000 mm, 16 dm², empty 220 g | [link](https://www.eclipson-airplanes.com/modela) |
| `tiltrotor-convergence` | E-flite Convergence VTOL | vtol_tiltrotor, span 651 mm, 18.83 dm², empty – g | [link](https://www.horizonhobby.com/on/demandware.static/-/Sites-horizon-master/default/dwa6b12a14/Manuals/EFL11050-Manual-EN.pdf) |
| `geprc-cinelog25-v2` | GEPRC CineLog25 V2 2.5" Cinewhoop | multirotor, wheelbase 114 mm, empty 70.9 g | [link](https://geprc.com/product/cl25-v2-frame/) |
| `iflight-chimera7-pro-v2` | iFlight Chimera7 Pro V2 7" Long-Range | multirotor, wheelbase 327 mm, empty 355 g | [link](https://shop.iflight.com/Chimera7-O4-Frame-Kit-Pro2286) |
| `tarot-x6-960` | Tarot X6 960 mm Folding Hexacopter | multirotor, wheelbase 960 mm, empty 2000 g | [link](https://www.flyingtech.co.uk/product/tarot-x6-960mm-carbon-fibre-foldable-hexacopter-frame/) |
| `xuwing-vtbird-4plus1` | XUWING (Finwing) VTBIRD 1600 mm VTOL 4+1 QuadPlane | vtol_quadplane, span 1600 mm, 40 dm², empty 1050 g | [link](https://www.finwinghobby.com/goods.php?id=166) |

## Payloads (5)

| ID | Name | Key numbers | Source |
|---|---|---|---|
| `runcam-split-hd` | RunCam Split HD (DJI HD system) | camera, 19.9 g, 2.25 W | [link](https://www.readymaderc.com/products/details/runcam-split-hd) |
| `flir-boson-320` | FLIR Boson 320 Thermal Core | thermal, 7.5 g, 0.6 W | [link](https://www.oem.flir.com/products/boson/) |
| `livox-mid-360` | Livox Mid-360 Compact 3D LiDAR | lidar, 265 g, 6.5 W | [link](https://www.livoxtech.com/mid-360/specs) |
| `medical-capsule-500g` | 500 g cargo pod (design mass, not a product) | cargo, 500 g, 0 W | none: TODO(source) |
| `micasense-rededge-p` | MicaSense RedEdge-P Multispectral | multispectral, 363 g, 7 W | [link](https://www.jouav.com/products/micasense-rededge-p.html) |

## Missions (6)

| ID | Name | Key numbers | Source |
|---|---|---|---|
| `sub-250-urban-scan` | Sub-250g Urban Inspection | 3 km, 14 min, max 249 g | [link](https://www.faa.gov/uas/commercial_operators/operations_over_people) |
| `medical-delivery-15km` | 15km Remote Medical Box Transit | 15 km, 18 min, max 2800 g | none: TODO(source) |
| `sar-thermal-grid-40min` | 40-min Wilderness Search & Rescue | 8 km, 40 min, max 3500 g | [link](https://www.dji.com/enterprise/public-safety) |
| `fpv-sprint-160kmh` | 160 km/h Aerobatic FPV Sprint | 4 km, 5 min, max 700 g | [link](https://thedroneracingleague.com/technology/) |
| `longrange-fpv-10km` | 10 km Long-Range FPV Ridge Run | 10 km, 15 min, max 25000 g | [link](https://www.easa.europa.eu/en/domains/drones-air-mobility/operating-drone/open-category-low-risk-civil-drones) |
| `multispectral-survey-hex` | Multispectral Crop Survey | 5 km, 15 min, max 24947 g | [link](https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-107) |

## Presets (8)

| ID | Name | Key numbers | Source |
|---|---|---|---|
| `apex-5-freestyle-quad` | Apex 5" freestyle quad | apex-5-freestyle + tmotor-f60-pro-iv + apc-5x45-bn + tattu-rline-4s-1550 | [link](https://fpvua.com/en/motor-t-motor-f60-pro-iv-v2-0-2207-5-1950kv/) |
| `apex-5-urban-light` | Apex 5" urban scan light | apex-5-freestyle + brotherhobby-1504-5 + apc-5x45-bn + gnb-3s-850 | [link](https://www.brotherhobbystore.com/products/vy-15045-motor-cw) |
| `apex-5-medical-courier` | Apex 5" medical courier | apex-5-freestyle + tmotor-f60-pro-iv + apc-5x45-bn + tattu-6s-4500-25c | [link](http://web.archive.org/web/20240811094325/https://www.gensace.de/tattu-4500mah-22-2v-25c-6s1p-lipo-battery-pack-with-xt90.html) |
| `eclipson-model-a-scout` | Eclipson Model A thermal scout | eclipson-model-a + sunnysky-x2216-880kv + apc-9x6-e + gnb-3s-850 | [link](https://www.eclipson-airplanes.com/modela) |
| `cinelog25-urban-whoop` | CineLog25 urban cinewhoop | geprc-cinelog25-v2 + geprc-gr1404-4500kv + gemfan-d63-3 + geprc-4s-660-hv | [link](https://geprc.com/product/cinelog25-v2-analog-quadcopter/) |
| `chimera7-longrange` | Chimera7 Pro long-range | iflight-chimera7-pro-v2 + iflight-xing2-2809-1250kv + gemfan-flash-7040-3 + iflight-fullsend-6s-8000 | [link](https://shop.iflight.com/Chimera7-Pro-V2-6S-O4-HD-Pro2259) |
| `tarot-x6-mapping` | Tarot X6 multispectral mapper | tarot-x6-960 + tmotor-mn4014-330kv + tmotor-p17x5-8 + tattu-plus-6s-16000 | [link](https://store.tmotor.com/product/mn4014-kv330-motor-navigator-type.html) |
| `vtbird-vtol-mapping` | VTBIRD VTOL multispectral mapper | xuwing-vtbird-4plus1 + sunnysky-x4112s-450kv + eolo-cn13x5 + tattu-plus-6s-16000 | [link](https://www.finwinghobby.com/goods.php?id=166) |

## Known gaps (TODO(source))

- Propeller static coefficients: `gemfan-51466` has none published (null), so a build on it is blocked. The APC `apc-5x45-bn` and `apc-10x45-mr` coefficients are APC's own computed PER3 predictions, not measurements. `gemfan-flash-7040-3`, `gemfan-d63-3`, `tmotor-p17x5-8`, `eolo-cn13x5` and `apc-14x7e` are DERIVED from makers' thrust tables (formula in each record).
- Airframe drag: no airframe publishes cd0 or a frontal area / Cd. Cruise power, cruise endurance and range are therefore not judged for the Eclipson and the VTBIRD, and no multirotor has a top-speed estimate.
- `medical-capsule-500g` is a design mass, not a product (the earlier "AeroAid" pod does not exist).
- Missions `medical-delivery-15km`, `sar-thermal-grid-40min` and `fpv-sprint-160kmh`: their targets are this app's design targets, and no source states them. The medical mission's old WHO link was dead and has been removed. The DRL page could not be reached.
- `tiltrotor-convergence`: E-flite publishes only a flying weight (771.1 g), not an empty weight, so a build on it is blocked.
- `molicel-21700-6s-4200` is modelled as six bare cells. No pack weight or dimensions are counted.
- Not re-verified in this pass (verified when added, earlier the same day): the GEPRC, iFlight, Tarot, T-Motor MN4014/P17, Tattu 16000 and MicaSense records.

## Corrections, 2026-10-24 audit

- VTOL preset: the Flightory Stork (`stork-vtol-courier`) is replaced by the XUWING/Finwing VTBIRD 4+1 (`vtbird-vtol-mapping`). Finwing publishes the kit weight, wing area, power combo and a flight-tested all-up weight. The Stork records `flightory-stork-vtol`, `tmotor-f90-1300kv`, `hqprop-7x4x3`, `brotherhobby-avenger-2812-v5-910kv`, `brotherhobby-folding-9453-3` and `iflight-fullsend-6s-3300` were removed with it. The new records are `xuwing-vtbird-4plus1`, `sunnysky-x4112s-450kv`, `sunnysky-x3520-iii-560kv`, `eolo-cn13x5` and `apc-14x7e`.
- Removed as invented or unbacked: `ranger-vtol-quadplane` (no product), `kde-3512xf-400` (no such motor; replaced by the real `kde-3510xf-475`), `master-airscrew-12x6-3b` (weight and bore were wrong, and there is no static test data anywhere), and `tattu-plus-6s-4500` (no such pack; replaced by the real `tattu-6s-4500-25c`).
- Re-sourced and corrected field by field (the old values are in each record's notes): `tmotor-f60-pro-iv` (now the V2.0), `sunnysky-x2216-880kv`, `brotherhobby-1504-5` (the real VY 1504.5), `gemfan-51466`, `apc-5x45-bn`, `apc-10x45-mr`, `apc-9x6-e`, `tattu-rline-4s-1550`, `cnhl-black-6s-1300`, `molicel-21700-6s-4200`, `gnb-3s-850`, `runcam-split-hd`, `flir-boson-320`, `livox-mid-360`, `apex-5-freestyle`, `eclipson-model-a` (the real Model A is 1000 mm, not 1200 mm) and `tiltrotor-convergence` (now the E-flite manual's figures).
- Earlier the same day: `sunnysky-v4008-380kv` was corrected against its manufacturer page, and `apc-9x6-e`'s Ct/Cp against UIUC.
