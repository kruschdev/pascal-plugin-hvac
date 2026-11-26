# IMC / UMC / ACCA Manual J-D-S / ASHRAE 62.2 / IECC Engineering Reference

## Simplified ACCA Manual J Load Calculation (`src/imc/sizing.ts`)

I ported and upgraded the climate-zone load engine to support all 14 ASHRAE climate zones (`1A`, `2A`, `2B`, `3A`, `3B`, `3C`, `4A`, `4B`, `4C`, `5A`, `5B`, `6A`, `6B`, `7`):

- **Base Thermal Factors**: Per-zone heating and cooling `BTU/hr per sq ft` at R-19 baseline, adjusted by wall insulation (`wallR`) and attic insulation (`atticR`) multipliers, room ceiling height scaling (`ceilingHeightFt / 8.5`, minimum `0.85`), room-category internal gains (kitchen appliances `+1200 BTU/h`, bathroom `+350 BTU/h`, excess glazing solar gain above baseline window ratio), and occupancy (`residential` `1.0x` vs `commercial` `1.25x`). Unconditioned spaces (`garage`, `exterior`, `attic`) are excluded from conditioned load.
- **Sensible vs. Latent Split**: Humid climate zones (`1A`, `2A`, `3A`, `4A`, `5A`, `6A`) apply a `0.75` sensible / `0.25` latent split; dry and marine zones (`2B`, `3B`, `3C`, `4B`, `4C`, `5B`, `6B`, `7`) apply a `0.88` sensible / `0.12` latent split.
- **Tonnage & Airflow**: Nominal cooling capacity rounds to standard half-ton increments from `1.5` to `5.0` tons (and whole-ton increments above `5.0` tons) with `400 CFM/ton` cooling airflow. In heating-dominated cold climates, `designTotalCfm` takes `Math.max(coolingCfm, heatingCfm)` where `heatingCfm` is rounded up in `25 CFM` increments from `totalHeatingBtuh / (1.08 * 55)` so furnace temperature rise stays well below the `70 deg F` limit.

## ACCA Manual D Equal-Friction Duct Sizing

- **Friction Target**: `0.10 in. wg / 100 ft` equal-friction target (`<= 1.15x` tolerance) using the ASHRAE / Manual D Darcy-Weisbach fit (`0.109136 * Q^1.9 / d^5.02 * roughMult`) with roughness multipliers of `1.0` for galvanized sheet metal, `1.35` for fiberglass ductboard, and `1.65` for R-6/R-8 flexible duct.
- **Huebscher Rectangular Equivalent Diameter**:
  - `Deq = 1.30 * (width * height)^0.625 / (width + height)^0.25`
- **Velocity Caps (ACCA Manual D, `MAX_DUCT_VELOCITY_FPM`)**:
  - Residential supply trunk: `<= 900 FPM` (branch `<= 700 FPM`)
  - Residential return trunk: `<= 700 FPM` (branch `<= 600 FPM`)
  - Residential exhaust: `<= 800 FPM`, fresh-air ERV: `<= 700 FPM`
  - Commercial supply trunk: `<= 1,400 FPM` (branch `<= 1,000 FPM`)
  - Commercial return trunk: `<= 1,100 FPM` (branch `<= 900 FPM`)
  - Commercial exhaust: `<= 1,200 FPM`, fresh-air ERV: `<= 1,000 FPM`

## ACCA Manual S Equipment & Refrigerant Linesets

- **Minimum Efficiency**: Regional `SEER2` floor (`15.2 SEER2` for `< 3.75` tons in southern climate zones `1A` through `3C`, `14.3 SEER2` otherwise) and `7.5 HSPF2` national heat pump minimum (`0 HSPF2` for cooling-only AC condensers and gas furnaces).
- **A2L & Legacy Refrigerants**: Supports `R-454B` (default A2L), `R-32`, and `R-410A`. Liquid/suction copper tubing scales per `REFRIGERANT_LINESET_TABLE`: `3/8" / 3/4"` (`<= 3.0 ton`), `3/8" / 7/8"` (`<= 4.0 ton`), `3/8" / 1-1/8"` (`<= 5.0 ton`), `1/2" / 1-3/8"` (`<= 10.0 ton`), and `5/8" / 1-5/8"` (`<= 20.0 ton`).
- **Thermostat Wiring**: Recommends `18/8` thermostat cable for split heat pump systems and `18/5` for split gas furnace + AC systems.

## ASHRAE 62.2 Whole-Building Ventilation

- **Continuous Fresh Air**: `Q_fan = 0.03 * Area_sqft + 7.5 * (Bedrooms + 1)` CFM (rounded up in `5 CFM` increments, minimum `30 CFM`).
- **Local Exhaust**: `50 CFM` minimum per bathroom per IMC Table 403.3.1.1 (`calculateAshrae622Ventilation`; auto-populate installs `80 CFM` ultra-quiet bath exhaust fans) and `100 CFM` minimum kitchen exhaust (auto-populate installs `250 CFM` smooth rigid metallic range hoods per IMC 505.4).

## IECC Building Envelope & Duct Insulation

- **Unconditioned Attic Ducts (`IECC R403.3.1`)**: Enforces `>= R-8` insulation for supply and return ductwork whenever any horizontal duct segment or `>= 30%` of total duct path length runs in the unconditioned attic (`segmentMidY >= levelH + 0.05`).
- **Envelope Takeoff**: Computes wall batt rolls (`R-13` to `R-21`), attic blown-in cellulose bags (`R-30` to `R-60`, scoped to the elevation-sorted top conditioned floor footprint), rim-joist closed-cell spray foam kits, expanding air-seal foam cans, and acoustic caulk tubes for optional inclusion in the Priced BOM.

## Live IMC / UMC / NEC Audit Rules (`src/imc/audit.ts`)

| Rule / Code Ref | Severity | Condition Checked |
|---|---|---|
| `IMC 307.2.3` | Error | Indoor cooling coil / condensing furnace missing secondary overflow drain pan (outdoor RTUs exempt) |
| `IMC 307.2.3(3)` | Warning | Condensate SS2 overflow float cutoff switch disabled |
| `IMC 307.2.1` | Error / Warning | Gravity condensate drain pitches uphill or slopes `< 1/8"/ft` (Error), or indoor cooling coil level has zero `condensate-drain` runs (Warning) |
| `NEC 440.14` | Error | Outdoor condenser or RTU missing disconnecting means within sight |
| `IFGC 402` | Info | Gas furnace (`gasBtuh > 0`) present without a same-level plumbing `fuel-gas` run |
| `NEC 110.26(E)` | Error | HVAC duct invades an electrical panel's dedicated footprint (`minY = 0` to overhead) |
| `IRC R502.8` | Error | HVAC duct collides with a Priority #1 Structural beam or column obstacle (anisotropic rect duct AABB) |
| `TRADE-PRIORITY` | Error | HVAC duct collides with a Priority #2 Plumbing pipe or equipment unit |
| `ACCA Manual D` | Warning | Duct velocity exceeds quiet FPM limit for system type and occupancy |
| `IMC 505.4` | Error | Kitchen range hood exhaust uses non-metallic or flexible duct instead of smooth rigid metal |
| `IECC R403.3.1` | Error | Attic supply or return duct insulation is below climate-zone minimum (`R-8`) using segment-level attic detection |
| `IMC 1107` | Warning | Refrigerant lineset exceeds 50 ft pre-charged length (requires weigh-in charge) |
| `IMC 601` | Error | Ducted supply system on a building level has no return air pathway or return grille |
| `IMC 601.5 / IRC M1602.2` | Error | Return air grille placed inside a prohibited zone (`bathroom`, `garage`, `kitchen`, `utility`, `closet`, `attic`, or `exterior`) |
| `NEC Art. 440` | Warning | Powered HVAC equipment is not yet wired to a same-level electrical circuit when a panel exists |
