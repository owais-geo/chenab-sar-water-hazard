// ============================================================================
// PROJECT B: Chenab Valley Sentinel-1 SAR Surface Water & Terrain-Shadow Audit
// Study Area: Chenab River Corridor (Pul Doda - Baglihar - Ramban - Salal - Akhnoor)
// Datasets: Copernicus Sentinel-1 GRD + SRTM 30m DEM + NASA OPERA DSWx-S1
// ============================================================================

// 1. DEFINE STUDY AREA (Chenab Valley Corridor, J&K)
var aoi = ee.Geometry.Rectangle([74.70, 32.88, 75.60, 33.28]);
Map.centerObject(aoi, 10);
Map.setOptions('HYBRID');

// Study windows (1 complete hydrological cycle: Lean vs Monsoon 2025-2026)
var leanStart = '2025-12-01';
var leanEnd   = '2026-02-28';
var monStart  = '2026-07-01';
var monEnd    = '2026-09-30';

// SAR & Terrain Parameters
var vvThreshold = -16.0;   // dB threshold for dark specular water surface
var maxSlopeDeg = 15.0;    // Steep Himalayan slopes (>15 deg) cause radar shadow false positives

// 2. LOAD & FILTER SENTINEL-1 GRD (Consistent IW Mode, VV Band, Descending Pass)
function getS1Composite(startDate, endDate) {
  var col = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'))
    .select('VV');
  // Median composite + 30m focal median to suppress radar speckle noise
  var composite = col.median().focal_median(30, 'circle', 'meters').clip(aoi);
  return {image: composite, count: col.size()};
}

var leanS1 = getS1Composite(leanStart, leanEnd);
var monS1  = getS1Composite(monStart, monEnd);

// 3. TERRAIN SLOPE MASK (SRTM 30m DEM)
var srtm = ee.Image('USGS/SRTMGL1_003').clip(aoi);
var slope = ee.Terrain.slope(srtm);
var gentleTerrain = slope.lt(maxSlopeDeg);

// 4. WATER DETECTION: NAIVE VS TERRAIN-CORRECTED
function cleanWaterMask(vvImage, applyTerrainMask) {
  var raw = vvImage.lt(vvThreshold);
  var filtered = applyTerrainMask ? raw.and(gentleTerrain) : raw;
  // Remove isolated single-pixel radar speckle (<5 connected pixels)
  var denoised = filtered.updateMask(
    filtered.selfMask().connectedPixelCount(10, true).gte(5)
  ).unmask(0).clip(aoi);
  return denoised;
}

var naiveWaterMonsoon = cleanWaterMask(monS1.image, false);   // Includes mountain radar shadows!
var cleanWaterMonsoon = cleanWaterMask(monS1.image, true);    // Terrain-corrected monsoon water
var cleanWaterLean    = cleanWaterMask(leanS1.image, true);   // Terrain-corrected lean-season water

// False positives removed by terrain masking (steep-slope radar shadow)
var shadowFalsePositives = naiveWaterMonsoon.and(cleanWaterMonsoon.not());

// Seasonal Monsoon Expansion (new water in Monsoon vs Lean season)
var monsoonExpansion = cleanWaterMonsoon.and(cleanWaterLean.not());

// 5. BENCHMARK AGAINST NASA OPERA DSWx-S1 (30m Sentinel-1 Surface Water)
// Class 1 = Open water, Class 3 = Inundated vegetation, Class 251 = Layover/Shadow
var operaCol = ee.ImageCollection('OPERA/DSWX/L3_V1/S1')
  .filterBounds(aoi)
  .filterDate(monStart, monEnd)
  .select('WTR_Water_classification');

var operaWater = ee.Image(ee.Algorithms.If(
  operaCol.size().gt(0),
  operaCol.map(function(img) { return img.eq(1).or(img.eq(3)); }).max().clip(aoi),
  ee.Image(0).clip(aoi)
));

var operaLayoverShadow = ee.Image(ee.Algorithms.If(
  operaCol.size().gt(0),
  operaCol.map(function(img) { return img.eq(251); }).max().clip(aoi),
  ee.Image(0).clip(aoi)
));

// 6. AREA CALCULATION HELPER (km^2)
function calcAreaKm2(binaryMask) {
  var areaImg = binaryMask.unmask(0).multiply(ee.Image.pixelArea()).divide(1e6);
  var stats = areaImg.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: aoi,
    scale: 30,
    maxPixels: 1e9,
    bestEffort: true
  });
  return ee.Number(stats.values().get(0));
}

var naiveKm2   = calcAreaKm2(naiveWaterMonsoon);
var cleanMonKm2 = calcAreaKm2(cleanWaterMonsoon);
var cleanLeanKm2 = calcAreaKm2(cleanWaterLean);
var shadowKm2  = calcAreaKm2(shadowFalsePositives);
var expandKm2  = calcAreaKm2(monsoonExpansion);
var operaWaterKm2 = calcAreaKm2(operaWater);
var operaShadowKm2 = calcAreaKm2(operaLayoverShadow);
var falsePosPct = shadowKm2.divide(naiveKm2.max(0.001)).multiply(100);

// 7. PRINT COPY-PASTE SUMMARY TO CONSOLE
print('================ COPY THIS SUMMARY BACK TO ME ================');
print('Sentinel-1 Scenes Used (Lean Dec25-Feb26):', leanS1.count);
print('Sentinel-1 Scenes Used (Monsoon Jul-Sep26):', monS1.count);
print('OPERA DSWx-S1 Scenes Used (Monsoon):', operaCol.size());
print('Naive SAR Water Area — BEFORE slope mask (km²):', naiveKm2.format('%.2f'));
print('Terrain-Corrected Monsoon Water Area (km²):', cleanMonKm2.format('%.2f'));
print('Terrain-Corrected Lean-Season Water Area (km²):', cleanLeanKm2.format('%.2f'));
print('Monsoon Seasonal Water Expansion (km²):', expandKm2.format('%.2f'));
print('Mountain Radar Shadow False Positives Removed (km²):', shadowKm2.format('%.2f'));
print('False-Positive Reduction by DEM Masking (%):', falsePosPct.format('%.1f'));
print('NASA OPERA DSWx-S1 Monsoon Water Area (km²):', operaWaterKm2.format('%.2f'));
print('NASA OPERA Layover/Shadow Masked Area (km²):', operaShadowKm2.format('%.2f'));
print('==============================================================');

// 8. MONTHLY SURFACE WATER AREA TIME SERIES (Oct 2025 - Sep 2026)
var months = ee.List.sequence(0, 11);
var startCycle = ee.Date('2025-10-01');

var monthlyFeatures = ee.FeatureCollection(months.map(function(m) {
  var mStart = startCycle.advance(m, 'month');
  var mEnd   = mStart.advance(1, 'month');
  var mCol = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filterDate(mStart, mEnd)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'))
    .select('VV');
  var area = ee.Algorithms.If(
    mCol.size().gt(0),
    calcAreaKm2(cleanWaterMask(mCol.median().focal_median(30, 'circle', 'meters').clip(aoi), true)),
    0
  );
  return ee.Feature(null, {
    'month': mStart.format('YYYY-MM'),
    'water_km2': area
  });
}));

var monthlyChart = ui.Chart.feature.byFeature(monthlyFeatures, 'month', 'water_km2')
  .setChartType('ColumnChart')
  .setOptions({
    title: 'Chenab Valley Terrain-Corrected Surface Water Area (Oct 2025 – Sep 2026)',
    hAxis: {title: 'Month', slantedText: true},
    vAxis: {title: 'Surface Water Area (km²)', minValue: 0},
    legend: {position: 'none'},
    colors: ['#0b66c3']
  });
print(monthlyChart);

// 9. ADD MAP LAYERS (Turn layers on/off via the top-right "Layers" menu)
Map.addLayer(monS1.image, {min: -25, max: -5}, '1. Sentinel-1 VV Backscatter (Monsoon dB)', false);
Map.addLayer(operaLayoverShadow.selfMask(), {palette: ['#9e9e9e']}, '2. NASA OPERA Layover/Shadow Zone', false);
Map.addLayer(shadowFalsePositives.selfMask(), {palette: ['#e53935']}, '3. Mountain Shadow False Positives (Removed)', true);
Map.addLayer(cleanWaterLean.selfMask(), {palette: ['#0d47a1']}, '4. Lean-Season Water (Baglihar/Salal/Chenab)', true);
Map.addLayer(monsoonExpansion.selfMask(), {palette: ['#00e5ff']}, '5. Monsoon Water Expansion (Jul-Sep 2026)', true);
Map.addLayer(operaWater.selfMask(), {palette: ['#ffea00']}, '6. NASA OPERA DSWx-S1 Water Benchmark', false);
Map.addLayer(ee.Image().paint(aoi, 0, 2), {palette: ['#ffffff']}, 'Study Corridor Boundary', true);

// 10. ADD CLEAN LEGEND TO MAP FOR SCREENSHOTS
var legend = ui.Panel({
  style: {position: 'bottom-left', padding: '8px 12px', backgroundColor: 'rgba(255,255,255,0.92)'}
});
legend.add(ui.Label({
  value: 'Chenab SAR Water & Shadow Audit',
  style: {fontWeight: 'bold', fontSize: '13px', margin: '0 0 6px 0'}
}));

function addLegendRow(color, name) {
  var box = ui.Label({style: {backgroundColor: color, padding: '7px', margin: '0 6px 4px 0'}});
  var desc = ui.Label({value: name, style: {fontSize: '11px', margin: '0 0 4px 0'}});
  legend.add(ui.Panel({widgets: [box, desc], layout: ui.Panel.Layout.Flow('horizontal')}));
}

addLegendRow('#0d47a1', 'Lean-Season Surface Water (Clean)');
addLegendRow('#00e5ff', 'Monsoon Surface Water Expansion');
addLegendRow('#e53935', 'Mountain Radar Shadow False Positives (Removed)');
addLegendRow('#ffea00', 'NASA OPERA DSWx-S1 Benchmark (Toggle)');
Map.add(legend);
