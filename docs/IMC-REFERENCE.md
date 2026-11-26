# IMC / UMC / ACCA Manual J-D-S / ASHRAE 62.2 / IECC Engineering Reference

## Simplified ACCA Manual J Load Calculation (`src/imc/sizing.ts`)

I ported and upgraded the climate-zone load engine to support all 14 ASHRAE climate zones (`1A`, `2A`, `2B`, `3A`, `3B`, `3C`, `4A`, `4B`, `4C`, `5A`, `5B`, `6A`, `6B`, `7`):

- **Base Thermal Factors**: Per-zone heating and cooling `BTU/hr per sq ft` at R-19 baseline, adjusted by wall insulation (`wallR`) and attic insulation (`atticR`) multipliers, room ceiling height scaling (`ceilingHeightFt / 8`), room-category internal gains (kitchen appliances, south/west glazing solar gains, bathroom moisture), and occupancy (`residential` vs `commercial`).
- **Sensible vs. Latent Split**: Humid climate zones (`1A`, `2A`, `3A`, `4A`, `5A`, `6A`) apply a 0.72 sensible / 0.28 latent split; dry/marine zones apply 0.85 sensible / 0.15 latent.
- **Tonnage & Airflow**: Nominal cooling capacity rounds to standard half-ton increments (`1.5` to `25` tons) with `400 CFM/ton` design airflow (`375 CFM/ton` in humid zones for stronger latent dehumidification).

## ACCA Manual D Equal-Friction Duct Sizing

- **Friction Target**: `0.08 in. wg / 100 ft` equal-friction baseline for galvanized sheet metal (`roughness = 0.0003 ft`), with roughness corrections for R-6/R-8 flex duct (`0.003 ft`) and fiberglass ductboard (`0.003 ft`).
- **Huebscher Rectangular Equivalent Diameter**:
  - `Deq = 1.30 * (width * height)^0.625 / (width + height)^0.25`
- **Velocity Caps (ACCA Manual D)**:
  - Residential supply trunk: `<= 900 FPM` (branch `<= 700 FPM`)
  - Residential return trunk: `<= 700 FPM` (branch `<= 600 FPM`)
  - Commercial supply trunk: `<= 1,400 FPM` (branch `<= 1,000 FPM`)
  - Commercial return trunk: `<= 1,100 FPM` (branch `<= 850 FPM`)

## ACCA Manual S Equipment & Refrigerant Linesets

- **Minimum Efficiency**: Regional `SEER2` and `HSPF2` floors per climate zone (South/Southwest zones enforce higher cooling `SEER2`, cold northern zones enforce higher cold-climate `HSPF2`).
- **A2L & Legacy Refrigerants**: Supports `R-454B` (default A2L), `R-32`, and `R-410A`. Liquid/suction copper tubing scales from `3/8" / 5/8"` (`<= 2.0 ton`) up to `1/2" / 1-1/8"` (`>= 5.0 ton`).
- **Thermostat Wiring**: Recommends `18/8` thermostat cable for heat pumps/two-stage systems and `18/5` for single-stage gas furnace + AC.

## ASHRAE 62.2 Whole-Building Ventilation

- **Continuous Fresh Air**: `Q_fan = 0.03 * Area_sqft + 7.5 * (Bedrooms + 1)` CFM.
- **Local Exhaust**: `80 CFM` intermittent (`50 CFM` minimum) per bathroom and `100 CFM` vented kitchen range hood.

## IECC Building Envelope & Duct Insulation

- **Unconditioned Attic Ducts (`IECC R403.3.1`)**: Enforces `>= R-8` insulation for supply and return ductwork running above ceiling height (`avgY >= levelH + 0.05`).
- **Envelope Takeoff**: Computes wall batt rolls (`R-13` to `R-21`), attic blown-in cellulose bags (`R-30` to `R-60`), rim-joist closed-cell spray foam kits, expanding air-seal foam cans, and acoustic caulk tubes for optional inclusion in the Priced BOM.

## Live IMC / UMC / NEC Audit Rules (`src/imc/audit.ts`)

| Rule / Code Ref | Severity | Condition Checked |
|---|---|---|
| `IMC 307.2.3` | Error | Indoor cooling coil / condensing furnace missing secondary overflow drain pan |
| `IMC 307.2.3(3)` | Warning | Condensate SS2 overflow float cutoff switch disabled |
| `NEC 440.14` | Error | Outdoor condenser or RTU missing disconnecting means within sight |
| `IFGC 402` | Info | Gas furnace (`gasBtuh > 0`) present without a plumbing `fuel-gas` run |
| `NEC 110.26(E)` | Error | HVAC duct invades an electrical panel's dedicated footprint (`minY = 0` to overhead) |
| `IRC R502.8` | Error | HVAC duct collides with a Priority #1 Structural beam, column, or assembly |
| `TRADE-PRIORITY` | Error | HVAC duct collides with a Priority #2 Plumbing pipe or equipment unit |
| `ACCA Manual D` | Warning | Duct velocity exceeds quiet FPM limit for system type and occupancy |
| `IECC R403.3.1` | Error | Attic ductwork insulation is below climate-zone minimum (`R-8`) |
| `IMC 1107` | Warning | Refrigerant lineset exceeds 50 ft pre-charged length (requires weigh-in charge) |
| `IMC 601` | Error | Ducted supply system on a building level has no return air pathway or return grille |
| `NEC Art. 440` | Warning | Powered HVAC equipment is not yet wired to a same-level electrical circuit when a panel exists |
