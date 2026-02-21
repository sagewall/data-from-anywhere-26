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

// Type definition for cache entries, including the cached value and its expiration time
type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

// Cache Time to Live and request timeout values in milliseconds
const failedRequestCacheTimeToLive = 30 * 1000;
const forecastCacheTimeToLive = 5 * 60 * 1000;
const iconCacheTimeToLive = 30 * 60 * 1000;
const observationsCacheTimeToLive = 2 * 60 * 1000;
const pointsStationsCacheTimeToLive = 10 * 60 * 1000;
const requestTimeout = 8 * 1000;

// Headers for API requests, including a User-Agent as required by the NWS API
const headers = {
  accept: "application/geo+json",
  "User-Agent": "data-from-anywhere-26",
};

// App state to hold references to layers, cache data, and in-flight request promises
const state = {
  failedRequestCache: new Map<string, CacheEntry<boolean>>(),
  forecastLayer: null as GeoJSONLayer | null,
  forecastLayerUrl: "",
  forecastCache: new Map<string, CacheEntry<any>>(),
  iconStatusCache: new Map<string, CacheEntry<boolean>>(),
  inFlightIconChecks: new Map<string, Promise<boolean>>(),
  inFlightObservationStationsKey: "",
  inFlightRequests: new Map<string, Promise<any | null>>(),
  lastObservationStationsKey: "",
  latestObservationsCache: new Map<string, CacheEntry<any>>(),
  observationStationsLayer: null as GeoJSONLayer | null,
  observationStationsLayerUrl: "",
  observationStationsCache: new Map<string, CacheEntry<any>>(),
  pointsCache: new Map<string, CacheEntry<any>>(),
};

// Get a reference to the arcgis-feature element
const featureElement = document.querySelector(
  "arcgis-feature",
)! as HTMLArcgisFeatureElement;

// Get a reference to the toggle dialog button
const toggleDialogButton = document.querySelector(
  "#toggle-dialog",
) as HTMLButtonElement;

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

// ---- Event Listeners ----

// Add an event listener to the toggle dialog button to open or close the dialog when clicked
toggleDialogButton.addEventListener("click", () => {
  const dialog = document.getElementById("dialog") as HTMLCalciteDialogElement;
  if (dialog) {
    dialog.open = !dialog.open;
  }
});

// Event listener for when the view extent changes
viewElement.addEventListener("arcgisViewChange", () => {
  // Remove the existing forecast layer if it exists, as it may no longer be relevant to the new view extent
  removeExistingForecastLayer();

  // If the view is stationary after the change
  if (viewElement.stationary) {
    // Create or update the observation stations layer based on the new view center
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
  removeExistingForecastLayer();

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

// ---- Functions ----

// Function to check if an icon URL returns an HTTP 200 status,
// with a timeout and caching to avoid redundant checks
async function checkIconStatus(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    const isOk = response.status === 200;
    setCachedValue(state.iconStatusCache, url, isOk, iconCacheTimeToLive);
    return isOk;
  } catch {
    setCachedValue(state.iconStatusCache, url, false, iconCacheTimeToLive);
    return false;
  } finally {
    window.clearTimeout(timeoutId);
    state.inFlightIconChecks.delete(url);
  }
}

// Function to create the observation stations layer based on the current view center
async function createObservationStationsLayer(): Promise<void> {
  // Ensure the view center is defined before making requests
  if (!viewElement.center) {
    console.error("View center is not defined.");
    return;
  }

  // Get the latitude and longitude of the view center
  const centerLatitude = viewElement.center.latitude;
  const centerLongitude = viewElement.center.longitude;

  // Validate that the center coordinates are defined
  if (centerLatitude == null || centerLongitude == null) {
    console.error("View center coordinates are invalid.");
    return;
  }

  // Validate that the center coordinates are finite numbers before proceeding with the requests
  if (!Number.isFinite(centerLatitude) || !Number.isFinite(centerLongitude)) {
    console.error("View center coordinates are invalid.");
    return;
  }

  // Create a unique key for the current view center to determine if we need to request new observation stations data
  const observationStationsKey = `${normalizeCoordinate(centerLatitude)},${normalizeCoordinate(centerLongitude)}`;
  if (
    observationStationsKey === state.lastObservationStationsKey ||
    observationStationsKey === state.inFlightObservationStationsKey
  ) {
    return;
  }

  // Set the in-flight key to prevent duplicate requests for the same view center while the current request is still in progress
  state.inFlightObservationStationsKey = observationStationsKey;

  try {
    // Request NWS points data for the current view center
    const nwsPoints = await requestPoints(centerLatitude, centerLongitude);
    const observationStationsUrl =
      nwsPoints?.data?.properties?.observationStations;

    // If the NWS points data does not include an observation stations URL, do not proceed
    if (!observationStationsUrl) {
      return;
    }

    // Request observation stations using the URL from the NWS points data
    const observationStations = await requestObservationStations(
      observationStationsUrl,
    );

    // If the observation stations data does not include features, do not proceed
    if (!observationStations?.data?.features) {
      return;
    }

    // Deep clone the data to avoid mutating the original response
    const structuredStationData = structuredClone(observationStations.data);

    // Process each feature to get latest observations and forecast data
    const allFeaturePromises = structuredStationData.features.map(
      async (feature: any) => {
        try {
          // Get the station identifier, latitude, and longitude from the feature properties and geometry
          const stationIdentifier = feature?.properties?.stationIdentifier;
          const [longitude, latitude] = feature?.geometry?.coordinates ?? [];

          // If the station identifier is not defined, skip processing this feature
          if (!stationIdentifier) {
            console.warn(
              "Skipping feature with missing stationIdentifier",
              feature,
            );
            return;
          }

          // Request the latest observations and forecast data in parallel for the station
          const [observationProperties, forecastProperties] = await Promise.all(
            [
              requestLatestObservations(stationIdentifier),
              Number.isFinite(latitude) && Number.isFinite(longitude)
                ? requestForecast(latitude, longitude)
                : Promise.resolve(null),
            ],
          );

          // Process the properties of the observations and forecast data to flatten nested objects and arrays,
          // and merge them into the feature properties, with the original feature properties taking precedence in case of conflicts
          feature.properties = processProperties({
            ...feature.properties,
            ...(observationProperties?.data?.properties ?? {}),
            ...(forecastProperties?.data?.properties ?? {}),
          });
        } catch (error) {
          // Log any errors that occur during the processing of each feature, but continue processing the remaining features
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

    // Revoke the previous observation stations layer URL to free up memory, if it exists
    if (state.observationStationsLayerUrl) {
      URL.revokeObjectURL(state.observationStationsLayerUrl);
    }

    // Update the state with the new observation stations layer URL
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
    // after validating that the URL returns an HTTP 200 status,
    // and filter out any unique value infos that do not have a valid icon URL
    // to avoid broken image symbols on the map
    const uniqueValueInfos = renderer.uniqueValueInfos ?? [];
    renderer.uniqueValueInfos = (
      await Promise.all(
        uniqueValueInfos.map(async (info) => {
          // Get the icon URL from the value of the unique value info
          const iconUrl = String(info.value ?? "").trim();

          // Check if the icon URL is valid and returns an HTTP 200 status before creating a symbol for it,
          // to avoid broken image symbols on the map
          const iconIsAvailable = await isHttp200(iconUrl);

          if (!iconIsAvailable) {
            return null;
          }

          // Create a new symbol for the unique value info using the icon URL and set it on the info object
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

    // Mark this key as successfully refreshed only after the layer has been built and added
    state.lastObservationStationsKey = observationStationsKey;
  } finally {
    if (state.inFlightObservationStationsKey === observationStationsKey) {
      state.inFlightObservationStationsKey = "";
    }
  }
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
                        // @ts-expect-error this is supported but missing from the type definition
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

// Function to perform a request to a given URL with deduplication and error handling,
async function executeRequest(
  cacheKey: string,
  url: string,
): Promise<any | null> {
  try {
    const response = await request(url, {
      headers,
      timeout: requestTimeout,
    });
    state.failedRequestCache.delete(cacheKey);
    return response;
  } catch (error) {
    setCachedValue(
      state.failedRequestCache,
      cacheKey,
      true,
      failedRequestCacheTimeToLive,
    );

    if (!isNotFoundError(error)) {
      console.error(`Request failed for ${url}`, error);
    }
    return null;
  } finally {
    state.inFlightRequests.delete(cacheKey);
  }
}

// Function to get a cached value from a cache Map,
// checking for expiration and returning null if the entry is not found or has expired
function getCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | null {
  // Check if there's a cache entry for the given key
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  // If the cache entry has expired, delete it from the cache and return null
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  // If the cache entry is valid, return its value
  return entry.value;
}

// Function to check if a given URL returns an HTTP 200 status,
// with caching to avoid redundant network requests for the same URL
async function isHttp200(url: string): Promise<boolean> {
  // If the URL is not defined or does not start with http:// or https://, return false
  if (!url) {
    return false;
  }

  // Only attempt to check URLs that start with http:// or https://
  // to avoid unnecessary requests for invalid URLs
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return false;
  }

  // Check the cache first to see if we have a recent result for this URL
  const cached = getCachedValue(state.iconStatusCache, url);
  if (cached !== null) {
    return cached;
  }

  // If there's an in-flight check for this URL, return the existing promise to avoid duplicate checks
  const inFlight = state.inFlightIconChecks.get(url);
  if (inFlight) {
    return inFlight;
  }

  // Perform a HEAD request to the URL to check if it returns an HTTP 200 status
  const checkPromise = checkIconStatus(url);

  // Store the in-flight check promise in the state to deduplicate concurrent checks for the same URL
  state.inFlightIconChecks.set(url, checkPromise);

  // Return the promise that will resolve to true if the URL returns an HTTP 200 status, or false otherwise
  return checkPromise;
}

// Function to determine if an error is a 404 Not Found error by checking various properties
// of the error object, including HTTP status codes and message content, to avoid logging
// expected 404 errors as actual errors in the console
function isNotFoundError(error: any): boolean {
  // Check various properties of the error object to determine if it indicates a 404 Not Found error
  const status =
    error?.details?.httpStatus ??
    error?.response?.status ??
    error?.status ??
    error?.httpStatus;

  // If any of the status properties indicate a 404 status, return true
  if (Number(status) === 404) {
    return true;
  }

  // As a fallback, check if the error message contains "404"
  // to catch any cases where the status code is not available in a standard property
  return /\b404\b/.test(String(error?.message ?? ""));
}

// Function to normalize coordinate values to a fixed number of decimal places for consistent cache keys
function normalizeCoordinate(value: number): string {
  return value.toFixed(4);
}

// Function to create custom popup content for forecast and observation station features
function popupContentCreator(event: any): HTMLCalciteListElement {
  // Get the attributes from the graphic associated with the popup event
  const attributes = event.graphic.attributes;

  // Create a calcite-list element to hold the popup content
  const list = document.createElement("calcite-list");

  // If the attributes include current conditions data (temperature or text description),
  // create a list item for the current conditions
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

    // If there's an icon URL for the current conditions,
    // create an img element and add it to the list item
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

    // Add the current conditions list item to the top of the list
    list.appendChild(currentConditionsListItem);
  }

  // Loop through the forecast periods (up to 6) and create a list item for each period with its name,
  // detailed forecast, and icon if available, then add it to the list
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

  // Return the populated list element to be used as the custom content for the popup
  return list;
}

// Recursive function to process properties as some are nested objects or arrays
function processProperties(object: any, prefix = ""): any {
  // Create a new result object to hold the processed properties
  const result: any = {};

  // Loop through each key-value pair in the input object and process them based on their type
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

  // Return the processed result object with flattened properties
  return result;
}

function removeExistingForecastLayer(): void {
  // If there's an existing forecast layer, remove it before adding a new one
  if (state.forecastLayer) {
    viewElement.map?.layers.remove(state.forecastLayer);
    state.forecastLayer = null;
  }

  // Clear the graphic from the Feature element to reset the popup content
  featureElement.graphic = null;
}

// Function to request forecast data from latitude and longitude
async function requestForecast(
  latitude: number,
  longitude: number,
): Promise<any | null> {
  // If latitude or longitude are not defined, return null
  if (latitude == null || longitude == null) {
    return null;
  }

  // Validate that latitude and longitude are finite numbers before proceeding with the request
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  // Request the NWS Points data for the given latitude and longitude to get the forecast URL,
  // and if successful, use that URL to request the forecast data
  const points = await requestPoints(latitude, longitude);
  const forecastUrl = points?.data?.properties?.forecast;

  // If the forecast URL is not defined in the Points response,
  // return null as we cannot proceed with the forecast request
  if (!forecastUrl) {
    return null;
  }

  // Request the forecast data directly from the forecast URL and return the response
  return requestForecastByUrl(forecastUrl);
}

// Function to request forecast data directly from a forecast URL
async function requestForecastByUrl(forecastUrl: string): Promise<any | null> {
  // If the forecast URL is not defined, return null
  if (!forecastUrl) {
    return null;
  }

  // Check the cache first to see if we have a recent response for this forecast URL
  const cacheKey = `forecast:${forecastUrl}`;
  const cached = getCachedValue(state.forecastCache, cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Request the forecast data from the URL, and if successful, cache the response before returning it
  const response = await requestWithDedupe(cacheKey, forecastUrl);
  if (response) {
    setCachedValue(
      state.forecastCache,
      cacheKey,
      response,
      forecastCacheTimeToLive,
    );
  }

  // Return the forecast response,which may be null if the request failed or if the URL was not defined
  return response;
}

// Function to request latest observations for a station
async function requestLatestObservations(
  stationIdentifier: string,
): Promise<any | null> {
  // If the station identifier is not defined, return null
  if (!stationIdentifier) {
    return null;
  }

  // Construct the URL for the latest observations endpoint using the station identifier
  const url = `https://api.weather.gov/stations/${stationIdentifier}/observations/latest`;

  // Check the cache first to see if we have a recent response for this station's latest observations
  const cacheKey = `observations:${stationIdentifier}`;
  const cached = getCachedValue(state.latestObservationsCache, cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Request the latest observations data from the URL, and if successful,
  // cache the response before returning it
  const response = await requestWithDedupe(cacheKey, url);
  if (response) {
    setCachedValue(
      state.latestObservationsCache,
      cacheKey,
      response,
      observationsCacheTimeToLive,
    );
  }

  // Return the latest observations response, which may be null if the request
  // failed or if the station identifier was not defined
  return response;
}

// Function to request observation stations from NWS Points data
async function requestObservationStations(
  observationStationsUrl: string,
): Promise<any | null> {
  // If the observation stations URL is not defined, return null
  if (!observationStationsUrl) {
    return null;
  }

  // Check the cache first to see if we have a recent response for this observation stations URL
  const cacheKey = `stations:${observationStationsUrl}`;
  const cached = getCachedValue(state.observationStationsCache, cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Request the observation stations data from the URL, and if successful, cache the response before returning it
  const response = await requestWithDedupe(cacheKey, observationStationsUrl);
  if (response) {
    setCachedValue(
      state.observationStationsCache,
      cacheKey,
      response,
      pointsStationsCacheTimeToLive,
    );
  }

  // Return the observation stations response, which may be null
  // if the request failed or if the URL was not defined
  return response;
}

// Function to request NWS Points data based on latitude and longitude
async function requestPoints(
  latitude: number,
  longitude: number,
): Promise<any | null> {
  // If latitude or longitude are not defined, return null
  if (latitude == null || longitude == null) {
    return null;
  }

  // Validate that latitude and longitude are finite numbers before proceeding with the request
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  // Normalize the latitude and longitude to a fixed number of decimal places to create a consistent cache key,
  const normalizedLatitude = normalizeCoordinate(latitude);
  const normalizedLongitude = normalizeCoordinate(longitude);
  const cacheKey = `points:${normalizedLatitude},${normalizedLongitude}`;

  // Check the cache first to see if we already have a recent points response for this coordinate
  const cached = getCachedValue(state.pointsCache, cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Request the NWS Points data for the given latitude and longitude, and if successful,
  // cache the response before returning it
  const response = await requestWithDedupe(
    cacheKey,
    `https://api.weather.gov/points/${normalizedLatitude},${normalizedLongitude}`,
  );

  // If the response is valid, cache it with the appropriate TTL before returning it
  if (response) {
    setCachedValue(
      state.pointsCache,
      cacheKey,
      response,
      pointsStationsCacheTimeToLive,
    );
  }

  // Return the points response, which may be null if the request failed
  // or if the latitude/longitude were not defined
  return response;
}

// Function to perform a request with deduplication based on a cache key,
// ensuring that only one request is made for the same key at a time,
// and that the result is cached for future requests
async function requestWithDedupe(
  cacheKey: string,
  url: string,
): Promise<any | null> {
  // If this key recently failed, skip an immediate retry and return null
  const recentlyFailed = getCachedValue(state.failedRequestCache, cacheKey);
  if (recentlyFailed === true) {
    return null;
  }

  // If there's an in-flight request for the given cache key,
  // return the existing promise to avoid duplicate requests
  const inFlight = state.inFlightRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  // Perform the request to the given URL, and if it fails with an error other than a 404 Not Found,
  // log the error to the console for debugging purposes
  const requestPromise = executeRequest(cacheKey, url);

  // Store the in-flight request promise in the state to deduplicate concurrent requests
  // for the same cache key
  state.inFlightRequests.set(cacheKey, requestPromise);

  // Return the promise that will resolve to the response data if the request is successful,
  // or null if it fails
  return requestPromise;
}

// Function to set a value in a cache Map with an associated TTL,
// storing the value along with its expiration time
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
