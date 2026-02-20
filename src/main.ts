import Color from "@arcgis/core/Color.js";
import WebMap from "@arcgis/core/WebMap.js";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import CustomContent from "@arcgis/core/popup/content/CustomContent.js";
import SimpleRenderer from "@arcgis/core/renderers/SimpleRenderer.js";
import request from "@arcgis/core/request.js";
import { createRenderer } from "@arcgis/core/smartMapping/renderers/type.js";
import CIMSymbol from "@arcgis/core/symbols/CIMSymbol";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol.js";
import "@arcgis/map-components/components/arcgis-feature";
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-search";
import "@esri/calcite-components/components/calcite-action";
import "@esri/calcite-components/components/calcite-dialog";
import "@esri/calcite-components/components/calcite-link";
import "@esri/calcite-components/components/calcite-navigation";
import "@esri/calcite-components/components/calcite-navigation-logo";
import "@esri/calcite-components/components/calcite-notice";
import "@esri/calcite-components/components/calcite-shell";
import "@esri/calcite-components/components/calcite-tooltip";
import "./style.css";
import WebStyleSymbol from "@arcgis/core/symbols/WebStyleSymbol";

const FORECAST_CACHE_TTL_MS = 5 * 60 * 1000;
const OBSERVATIONS_CACHE_TTL_MS = 2 * 60 * 1000;
const POINTS_STATIONS_CACHE_TTL_MS = 10 * 60 * 1000;
const ICON_CACHE_TTL_MS = 30 * 60 * 1000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

// Application state to keep track of layers
const state = {
  forecastLayer: null as GeoJSONLayer | null,
  forecastLayerUrl: "",
  forecastCache: new Map<string, CacheEntry<any>>(),
  iconStatusCache: new Map<string, CacheEntry<boolean>>(),
  inFlightIconChecks: new Map<string, Promise<boolean>>(),
  inFlightRequests: new Map<string, Promise<any | null>>(),
  lastObservationStationsKey: "",
  latestObservationsCache: new Map<string, CacheEntry<any>>(),
  observationStationsLayer: null as GeoJSONLayer | null,
  observationStationsLayerUrl: "",
  observationStationsCache: new Map<string, CacheEntry<any>>(),
  pointsCache: new Map<string, CacheEntry<any>>(),
};

// Headers for API requests, including a User-Agent as required by the NWS API
const headers = {
  accept: "application/geo+json",
  "User-Agent": "data-from-anywhere-26",
};

// Get a reference to the arcgis-feature element
const featureElement = document.querySelector(
  "arcgis-feature",
)! as HTMLArcgisFeatureElement;

// Get a reference to the arcgis-map element
const viewElement = document.querySelector(
  "arcgis-map",
)! as HTMLArcgisMapElement;

// Create a WebMap instance
const webMap = new WebMap({
  basemap: "topo-vector",
});

// Set the map on the view element
viewElement.map = webMap;

// Wait for the view to be ready
await viewElement.viewOnReady();

// Set zoom constraints
viewElement.constraints.minZoom = 9;
viewElement.constraints.maxZoom = 15;

// Event listener for when the view extent changes
viewElement.addEventListener("arcgisViewChange", () => {
  if (viewElement.stationary) {
    createObservationStationsLayer();
  }
});

// Event listener for when the view is clicked
viewElement.addEventListener("arcgisViewClick", async (event) => {
  // Get the map point from the click event
  const { mapPoint } = event.detail;

  // Get the latitude and longitude from the map point
  const { latitude, longitude } = mapPoint;

  // If there's an existing forecast layer, remove it before adding a new one
  if (state.forecastLayer) {
    viewElement.map?.layers.remove(state.forecastLayer);
  }

  // Clear the graphic from the Feature element to reset the popup content
  featureElement.graphic = null;

  // Perform a hit test to check if the click was on an existing station feature
  const hitTestResult = await viewElement.hitTest(event.detail, {
    include: viewElement.map?.layers.filter(
      (layer) => layer.title === "NWS Observation Stations",
    ),
  });

  // If the click was on an existing station feature, do not add a new forecast layer or update the popup content,
  // as the existing station's popup will handle that. Also, if latitude or longitude are not defined,
  // do not proceed with the forecast request.
  if (hitTestResult.results.length > 0 || !latitude || !longitude) {
    return;
  }

  // Request forecast data for the clicked location
  const forecast = await requestForecast(latitude, longitude);

  if (!forecast?.data?.properties) {
    return;
  }

  // Deep clone the forecast data to avoid mutating the original response
  const structuredForecastData = structuredClone(forecast.data);

  // Process the properties of the forecast data to flatten nested objects and arrays
  structuredForecastData.properties = processProperties(
    forecast.data.properties,
  );

  // Create a Blob from the processed data
  const blob = new Blob([JSON.stringify(structuredForecastData)], {
    type: "application/geo+json",
  });

  // Create a URL for the Blob
  const url = URL.createObjectURL(blob);

  if (state.forecastLayerUrl) {
    URL.revokeObjectURL(state.forecastLayerUrl);
  }
  state.forecastLayerUrl = url;

  // Create a new GeoJSONLayer for the forecast data and add it to the map
  state.forecastLayer = new GeoJSONLayer({
    copyright: "NWS",
    popupEnabled: false,
    popupTemplate: {
      title: `Forecast for ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
      content: [
        new CustomContent({
          outFields: [
            "icon",
            "temperature_value",
            "textDescription",
            "periods_0_name",
            "periods_0_detailedForecast",
            "periods_0_icon",
            "periods_1_name",
            "periods_1_detailedForecast",
            "periods_1_icon",
            "periods_2_name",
            "periods_2_detailedForecast",
            "periods_2_icon",
            "periods_3_name",
            "periods_3_detailedForecast",
            "periods_3_icon",
            "periods_4_name",
            "periods_4_detailedForecast",
            "periods_4_icon",
            "periods_5_name",
            "periods_5_detailedForecast",
            "periods_5_icon",
          ],
          creator: popupContentCreator,
        }),
      ],
    },
    renderer: new SimpleRenderer({
      symbol: new SimpleFillSymbol({
        color: new Color([255, 0, 0, 0.25]),
        outline: {
          color: new Color([255, 0, 0]),
          width: 1,
        },
      }),
    }),
    title: "Forecast Area",
    url,
  });

  // Add the forecast layer to the map
  viewElement.map?.layers.add(state.forecastLayer);

  // Get the first graphic from the forecast layer and set it on the Feature element to display the popup content
  const graphics = await state.forecastLayer.queryFeatures();
  const graphic = graphics.features[0];
  featureElement.graphic = graphic;
});

// Function to create the observation stations layer based on the current view center
async function createObservationStationsLayer(): Promise<void> {
  // Ensure the view center is defined before making requests
  if (!viewElement.center) {
    console.error("View center is not defined.");
    return;
  }

  const centerLatitude = viewElement.center.latitude;
  const centerLongitude = viewElement.center.longitude;

  if (centerLatitude == null || centerLongitude == null) {
    console.error("View center coordinates are invalid.");
    return;
  }

  if (!Number.isFinite(centerLatitude) || !Number.isFinite(centerLongitude)) {
    console.error("View center coordinates are invalid.");
    return;
  }

  const observationStationsKey = `${normalizeCoordinate(centerLatitude)},${normalizeCoordinate(centerLongitude)}`;
  if (observationStationsKey === state.lastObservationStationsKey) {
    return;
  }
  state.lastObservationStationsKey = observationStationsKey;

  // Request NWS points data for the current view center
  const nwsPoints = await requestPoints(centerLatitude, centerLongitude);
  const observationStationsUrl =
    nwsPoints?.data?.properties?.observationStations;

  if (!observationStationsUrl) {
    return;
  }

  // Request observation stations using the URL from the NWS points data
  const observationStations = await requestObservationStations(
    observationStationsUrl,
  );

  if (!observationStations?.data?.features) {
    return;
  }

  // Deep clone the data to avoid mutating the original response
  const structuredStationData = structuredClone(observationStations.data);

  // Process each feature to get latest observations and forecast data
  const allFeaturePromises = structuredStationData.features.map(
    async (feature: any) => {
      try {
        const stationIdentifier = feature?.properties?.stationIdentifier;
        const [longitude, latitude] = feature?.geometry?.coordinates ?? [];
        const stationForecastUrl = feature?.properties?.forecast;

        const [observationProperties, forecastProperties] = await Promise.all([
          requestLatestObservations(stationIdentifier),
          stationForecastUrl
            ? requestForecastByUrl(stationForecastUrl)
            : Number.isFinite(latitude) && Number.isFinite(longitude)
              ? requestForecast(latitude, longitude)
              : Promise.resolve(null),
        ]);

        feature.properties = processProperties({
          ...feature.properties,
          ...(observationProperties?.data?.properties ?? {}),
          ...(forecastProperties?.data?.properties ?? {}),
        });
      } catch (error) {
        console.error(
          `Failed to process data for feature with stationIdentifier ${feature.properties.stationIdentifier}`,
          error,
        );
      }
    },
  );

  // Wait for all feature data to be requested and processed
  await Promise.all(allFeaturePromises);

  // Create a Blob from the processed data
  const blob = new Blob([JSON.stringify(structuredStationData)], {
    type: "application/geo+json",
  });

  // Create a URL for the Blob
  const url = URL.createObjectURL(blob);

  if (state.observationStationsLayerUrl) {
    URL.revokeObjectURL(state.observationStationsLayerUrl);
  }
  state.observationStationsLayerUrl = url;

  // Create a new GeoJSONLayer with the processed data
  const observationStationsLayer = new GeoJSONLayer({
    copyright: "NWS",
    popupEnabled: true,
    popupTemplate: {
      title: "{name} ({stationIdentifier})",
      content: [
        new CustomContent({
          outFields: [
            "icon",
            "temperature_value",
            "textDescription",
            "periods_0_name",
            "periods_0_detailedForecast",
            "periods_0_icon",
            "periods_1_name",
            "periods_1_detailedForecast",
            "periods_1_icon",
            "periods_2_name",
            "periods_2_detailedForecast",
            "periods_2_icon",
            "periods_3_name",
            "periods_3_detailedForecast",
            "periods_3_icon",
            "periods_4_name",
            "periods_4_detailedForecast",
            "periods_4_icon",
            "periods_5_name",
            "periods_5_detailedForecast",
            "periods_5_icon",
          ],
          creator: popupContentCreator,
        }),
      ],
    },
    title: "NWS Observation Stations",
    url,
  });

  // Create a renderer for the observation stations layer and set custom symbols based on the current conditions icon URL
  const { renderer } = await createRenderer({
    view: viewElement.view,
    layer: observationStationsLayer,
    field: "icon",
  });

  // Map each unique value info to a new symbol created from the icon URL
  const uniqueValueInfos = renderer.uniqueValueInfos ?? [];
  renderer.uniqueValueInfos = (
    await Promise.all(
      uniqueValueInfos.map(async (info) => {
        const iconUrl = String(info.value ?? "").trim();
        const iconIsAvailable = await isHttp200(iconUrl);

        if (!iconIsAvailable) {
          return null;
        }

        info.symbol = createObservationStationsSymbol(iconUrl);
        return info;
      }),
    )
  ).filter((info): info is NonNullable<typeof info> => info !== null);

  // Add a default symbol for features without a valid current conditions icon URL
  renderer.defaultSymbol = new WebStyleSymbol({
    name: "Radio Tower_Large_3",
    styleUrl:
      "https://www.arcgis.com/sharing/rest/content/items/37da62fcdb854f8e8305c79e8b5023dc/data",
  });

  // Set the renderer on the observation stations layer
  observationStationsLayer.renderer = renderer;

  // If there's an existing observation stations layer, remove it before adding the new one
  if (state.observationStationsLayer) {
    viewElement.map?.layers.remove(state.observationStationsLayer);
  }

  // Update the state with the new layer reference
  state.observationStationsLayer = observationStationsLayer;

  // Add the new layer to the map if it is not null
  viewElement.map?.layers.add(state.observationStationsLayer);
}

// Function for creating a CIMSymbol for observation stations
// using the current conditions icon URL
function createObservationStationsSymbol(url: string): CIMSymbol {
  return new CIMSymbol({
    data: {
      type: "CIMSymbolReference",
      symbol: {
        type: "CIMPointSymbol",
        symbolLayers: [
          {
            type: "CIMVectorMarker",
            enable: true,
            anchorPoint: {
              x: 0,
              y: 0,
            },
            anchorPointUnits: "Relative",
            size: 40,
            frame: {
              xmin: 0,
              ymin: 0,
              xmax: 17,
              ymax: 17,
            },
            markerGraphics: [
              {
                type: "CIMMarkerGraphic",
                geometry: {
                  rings: [
                    [
                      [8.5, 0],
                      [7.02, 0.13],
                      [5.59, 0.51],
                      [4.25, 1.14],
                      [3.04, 1.99],
                      [1.99, 3.04],
                      [1.14, 4.25],
                      [0.51, 5.59],
                      [0.13, 7.02],
                      [0, 8.5],
                      [0.13, 9.98],
                      [0.51, 11.41],
                      [1.14, 12.75],
                      [1.99, 13.96],
                      [3.04, 15.01],
                      [4.25, 15.86],
                      [5.59, 16.49],
                      [7.02, 16.87],
                      [8.5, 17],
                      [9.98, 16.87],
                      [11.41, 16.49],
                      [12.75, 15.86],
                      [13.96, 15.01],
                      [15.01, 13.96],
                      [15.86, 12.75],
                      [16.49, 11.41],
                      [16.87, 9.98],
                      [17, 8.5],
                      [16.87, 7.02],
                      [16.49, 5.59],
                      [15.86, 4.25],
                      [15.01, 3.04],
                      [13.96, 1.99],
                      [12.75, 1.14],
                      [11.41, 0.51],
                      [9.98, 0.13],
                      [8.5, 0],
                    ],
                  ],
                },
                symbol: {
                  type: "CIMPolygonSymbol",
                  symbolLayers: [
                    {
                      type: "CIMSolidStroke",
                      enable: true,
                      capStyle: "Round",
                      joinStyle: "Round",
                      miterLimit: 10,
                      width: 0.5,
                      color: [0, 0, 0, 255],
                    },
                    {
                      type: "CIMPictureMarker",
                      enable: true,
                      url,
                      scaleX: 1,
                      size: 20,
                      markerPlacement: {
                        type: "CIMMarkerPlacementPolygonCenter",
                        method: "OnPolygon",
                        offsetX: 0,
                        offsetY: 0,
                        clipAtBoundary: true,
                        placePerPart: true,
                      },
                    },
                  ],
                },
              },
            ],
            scaleSymbolsProportionally: true,
            respectFrame: true,
          },
        ],
        animations: [],
      },
    },
  });
}

async function isHttp200(url: string): Promise<boolean> {
  if (!url) {
    return false;
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return false;
  }

  const cached = getCachedValue(state.iconStatusCache, url);
  if (cached !== null) {
    return cached;
  }

  const inFlight = state.inFlightIconChecks.get(url);
  if (inFlight) {
    return inFlight;
  }

  const checkPromise = (async () => {
    try {
      const response = await fetch(url, { method: "HEAD" });
      const isOk = response.status === 200;
      setCachedValue(state.iconStatusCache, url, isOk, ICON_CACHE_TTL_MS);
      return isOk;
    } catch {
      setCachedValue(state.iconStatusCache, url, false, ICON_CACHE_TTL_MS);
      return false;
    } finally {
      state.inFlightIconChecks.delete(url);
    }
  })();

  state.inFlightIconChecks.set(url, checkPromise);
  return checkPromise;
}

// Function to create custom popup content for forecast and observation station features
function popupContentCreator(event: any): HTMLCalciteListElement {
  const attributes = event.graphic.attributes;

  const list = document.createElement("calcite-list");

  if (attributes.temperature_value || attributes.textDescription) {
    const currentConditionsListItem =
      document.createElement("calcite-list-item");
    currentConditionsListItem.label = "Current Conditions";
    const temperature = attributes.temperature_value
      ? (attributes.temperature_value * 9) / 5 + 32
      : "";
    const textDescription = attributes.textDescription
      ? attributes.textDescription
      : "";
    const description = `${textDescription ? textDescription + " " : "Unknown "}${temperature ? temperature.toFixed(1) + " °F" : ""}`;
    currentConditionsListItem.description = description;

    if (attributes.icon) {
      const img = document.createElement("img");
      img.src = attributes.icon;
      img.alt = attributes.textDescription
        ? attributes.textDescription
        : "Current Conditions Icon";
      img.style.maxWidth = "86px";
      img.slot = "content-start";
      currentConditionsListItem.appendChild(img);
    }

    list.appendChild(currentConditionsListItem);
  }

  for (let i = 0; i < 6; i++) {
    const forecastListItem = document.createElement("calcite-list-item");
    forecastListItem.label = attributes[`periods_${i}_name`]
      ? attributes[`periods_${i}_name`]
      : `Period ${i + 1}`;
    forecastListItem.description = attributes[`periods_${i}_detailedForecast`]
      ? attributes[`periods_${i}_detailedForecast`]
      : "No forecast available";

    if (attributes[`periods_${i}_icon`]) {
      const img = document.createElement("img");
      img.src = attributes[`periods_${i}_icon`];
      img.alt = attributes[`periods_${i}_detailedForecast`]
        ? attributes[`periods_${i}_detailedForecast`]
        : `Icon for Period ${i + 1}`;
      img.style.maxWidth = "86px";
      img.slot = "content-start";
      forecastListItem.appendChild(img);
    }

    list.appendChild(forecastListItem);
  }

  return list;
}

// Recursive function to process properties as some are nested objects or arrays
function processProperties(object: any, prefix = ""): any {
  const result: any = {};
  for (const [key, value] of Object.entries(object)) {
    const newKey = prefix ? `${prefix}_${key}` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === "object") {
          Object.assign(result, processProperties(item, `${newKey}_${index}`));
        } else {
          result[`${newKey}_${index}`] = String(item);
        }
      });
    } else if (value && typeof value === "object") {
      Object.assign(result, processProperties(value, newKey));
    } else {
      result[newKey] = value == null ? "" : String(value);
    }
  }
  return result;
}

// Function to request forecast data from latitude and longitude
async function requestForecast(
  latitude: number,
  longitude: number,
): Promise<any | null> {
  const points = await requestPoints(latitude, longitude);
  const forecastUrl = points?.data?.properties?.forecast;

  if (!forecastUrl) {
    return null;
  }

  return requestForecastByUrl(forecastUrl);
}

async function requestForecastByUrl(forecastUrl: string): Promise<any | null> {
  if (!forecastUrl) {
    return null;
  }

  const cacheKey = `forecast:${forecastUrl}`;
  const cached = getCachedValue(state.forecastCache, cacheKey);
  if (cached) {
    return cached;
  }

  const response = await requestWithDedupe(cacheKey, forecastUrl);
  if (response) {
    setCachedValue(
      state.forecastCache,
      cacheKey,
      response,
      FORECAST_CACHE_TTL_MS,
    );
  }
  return response;
}

// Function to request latest observations for a station
async function requestLatestObservations(
  stationIdentifier: string,
): Promise<any | null> {
  if (!stationIdentifier) {
    return null;
  }

  const url = `https://api.weather.gov/stations/${stationIdentifier}/observations/latest`;
  const cacheKey = `observations:${stationIdentifier}`;
  const cached = getCachedValue(state.latestObservationsCache, cacheKey);
  if (cached) {
    return cached;
  }

  const response = await requestWithDedupe(cacheKey, url);
  if (response) {
    setCachedValue(
      state.latestObservationsCache,
      cacheKey,
      response,
      OBSERVATIONS_CACHE_TTL_MS,
    );
  }
  return response;
}

// Function to request observation stations from NWS Points data
async function requestObservationStations(
  observationStationsUrl: string,
): Promise<any | null> {
  if (!observationStationsUrl) {
    return null;
  }

  const cacheKey = `stations:${observationStationsUrl}`;
  const cached = getCachedValue(state.observationStationsCache, cacheKey);
  if (cached) {
    return cached;
  }

  const response = await requestWithDedupe(cacheKey, observationStationsUrl);
  if (response) {
    setCachedValue(
      state.observationStationsCache,
      cacheKey,
      response,
      POINTS_STATIONS_CACHE_TTL_MS,
    );
  }
  return response;
}

// Function to request NWS Points data based on latitude and longitude
async function requestPoints(
  latitude: number,
  longitude: number,
): Promise<any | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const normalizedLatitude = normalizeCoordinate(latitude);
  const normalizedLongitude = normalizeCoordinate(longitude);
  const cacheKey = `points:${normalizedLatitude},${normalizedLongitude}`;
  const cached = getCachedValue(state.pointsCache, cacheKey);
  if (cached) {
    return cached;
  }

  const response = await requestWithDedupe(
    cacheKey,
    `https://api.weather.gov/points/${normalizedLatitude},${normalizedLongitude}`,
  );

  if (response) {
    setCachedValue(
      state.pointsCache,
      cacheKey,
      response,
      POINTS_STATIONS_CACHE_TTL_MS,
    );
  }
  return response;
}

function getCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): void {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function normalizeCoordinate(value: number): string {
  return value.toFixed(4);
}

function isNotFoundError(error: any): boolean {
  const status =
    error?.details?.httpStatus ??
    error?.response?.status ??
    error?.status ??
    error?.httpStatus;

  if (Number(status) === 404) {
    return true;
  }

  return /\b404\b/.test(String(error?.message ?? ""));
}

async function requestWithDedupe(
  cacheKey: string,
  url: string,
): Promise<any | null> {
  const inFlight = state.inFlightRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const requestPromise = (async () => {
    try {
      return await request(url, {
        headers,
      });
    } catch (error) {
      if (!isNotFoundError(error)) {
        console.error(`Request failed for ${url}`, error);
      }
      return null;
    } finally {
      state.inFlightRequests.delete(cacheKey);
    }
  })();

  state.inFlightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

document.getElementById("toggle-dialog")?.addEventListener("click", () => {
  const dialog = document.getElementById("dialog") as HTMLCalciteDialogElement;
  if (dialog) {
    dialog.open = !dialog.open;
  }
});
