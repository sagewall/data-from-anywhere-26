import Color from "@arcgis/core/Color.js";
import WebMap from "@arcgis/core/WebMap.js";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import CustomContent from "@arcgis/core/popup/content/CustomContent.js";
import type { PopupTemplateCreatorEvent } from "@arcgis/core/popup/types";
import SimpleRenderer from "@arcgis/core/renderers/SimpleRenderer.js";
import request from "@arcgis/core/request.js";
import { createRenderer } from "@arcgis/core/smartMapping/renderers/type.js";
import CIMSymbol from "@arcgis/core/symbols/CIMSymbol";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol.js";
import "@arcgis/map-components/components/arcgis-feature";
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-search";
import "@arcgis/map-components/components/arcgis-zoom";
import "@esri/calcite-components/components/calcite-action";
import "@esri/calcite-components/components/calcite-alert";
import "@esri/calcite-components/components/calcite-dialog";
import "@esri/calcite-components/components/calcite-link";
import "@esri/calcite-components/components/calcite-loader";
import "@esri/calcite-components/components/calcite-navigation";
import "@esri/calcite-components/components/calcite-navigation-logo";
import "@esri/calcite-components/components/calcite-notice";
import "@esri/calcite-components/components/calcite-shell";
import "@esri/calcite-components/components/calcite-tooltip";
import "./style.css";

// API response shape from NWS endpoints.
type ApiResponse = {
  data?: {
    features?: GeoJSONFeature[];
    properties?: Record<string, unknown>;
  };
};

// Generic cache entry with expiration.
type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

// Minimal GeoJSON feature shape used by this app.
type GeoJSONFeature = {
  geometry?: {
    coordinates?: unknown[];
  };
  properties?: Record<string, unknown>;
};

// Relative location shape from NWS points response.
type RelativeLocation = {
  city: string;
  state: string;
};

// Shared empty relative-location value used for fallbacks.
const emptyRelativeLocation: RelativeLocation = {
  city: "",
  state: "",
};

// ArcGIS request error shape used by error handling.
type RequestErrorLike = {
  details?: { httpStatus?: number };
  httpStatus?: number;
  message?: string;
  name?: string;
};

// Cache TTL and request timeout values in milliseconds.
const failedRequestCacheTimeToLive = 30 * 1000;
const forecastCacheTimeToLive = 5 * 60 * 1000;
const iconCacheTimeToLive = 30 * 60 * 1000;
const iconFailureCacheTimeToLive = 2 * 60 * 1000;
const iconHeadCheckAttempts = 2;
const iconHeadRetryDelay = 300;
const observationsCacheTimeToLive = 2 * 60 * 1000;
const pointsStationsCacheTimeToLive = 10 * 60 * 1000;
const requestTimeout = 8 * 1000;

// Headers for API requests, including a User-Agent as required by the NWS API.
const headers = {
  accept: "application/geo+json",
  "User-Agent": "data-from-anywhere-26",
};

// App state for layers, caches, and in-flight requests.
const state = {
  activeHttpRequestCount: 0,
  failedRequestCache: new Map<string, CacheEntry<boolean>>(),
  forecastCache: new Map<string, CacheEntry<ApiResponse>>(),
  forecastLayer: null as GeoJSONLayer | null,
  forecastLayerUrl: "",
  iconStatusCache: new Map<string, CacheEntry<boolean>>(),
  inFlightIconChecks: new Map<string, Promise<boolean>>(),
  inFlightObservationStationsKey: "",
  inFlightRequests: new Map<string, Promise<ApiResponse | null>>(),
  lastObservationStationsKey: "",
  latestObservationsCache: new Map<string, CacheEntry<ApiResponse>>(),
  observationStationsCache: new Map<string, CacheEntry<ApiResponse>>(),
  observationStationsLayer: null as GeoJSONLayer | null,
  observationStationsLayerUrl: "",
  pointsCache: new Map<string, CacheEntry<ApiResponse>>(),
};

// Get the arcgis-feature element.
const featureElement = document.querySelector(
  "arcgis-feature",
)! as HTMLArcgisFeatureElement;

// Get the map loader element.
const loaderElement = document.querySelector(
  "calcite-loader",
) as HTMLCalciteLoaderElement | null;

// Get the toggle dialog button.
const toggleDialogButton = document.querySelector(
  "#toggle-dialog",
) as HTMLButtonElement;

// Get the arcgis-map element.
const viewElement = document.querySelector(
  "arcgis-map",
)! as HTMLArcgisMapElement;

// Ensure loader starts hidden.
if (loaderElement) {
  loaderElement.hidden = true;
}

// Create the WebMap instance.
const webMap = new WebMap({
  basemap: "topo-vector",
});

// Set the map on the view element.
viewElement.map = webMap;

// Wait until the view is ready.
await viewElement.viewOnReady();

// Set zoom constraints.
viewElement.constraints.minZoom = 9;
viewElement.constraints.maxZoom = 11;

// ---- Event listeners ----

// Toggle the dialog when the button is clicked.
toggleDialogButton.addEventListener("click", () => {
  const dialog = document.getElementById("dialog") as HTMLCalciteDialogElement;
  if (dialog) {
    dialog.open = !dialog.open;
  }
});

// Handle view extent changes.
viewElement.addEventListener("arcgisViewChange", async () => {
  // Remove any stale forecast layer.
  removeExistingForecastLayer();

  // Refresh stations once the view is stationary.
  if (viewElement.stationary) {
    // Create or update the observation stations layer.
    try {
      await createObservationStationsLayer();
    } catch (error) {
      console.error("Failed to create observation stations layer", error);
    }
  }
});

// Handle map clicks.
viewElement.addEventListener("arcgisViewClick", async (event) => {
  // Read the map point from the click event.
  const mapPoint = event.detail.mapPoint;
  if (!mapPoint) {
    return;
  }

  // Extract click coordinates.
  const { latitude, longitude } = mapPoint;

  // Remove any existing forecast layer.
  removeExistingForecastLayer();

  // Hit test for existing station features.
  const hitTestResult = await viewElement.hitTest(event.detail, {
    include: viewElement.map?.layers.filter(
      (layer) => layer.title === "NWS Observation Stations",
    ),
  });

  // Skip if a station feature was clicked or if coordinates are invalid.
  const clickedCoordinates = tryGetFiniteCoordinates(latitude, longitude);
  if (hitTestResult.results.length > 0 || !clickedCoordinates) {
    return;
  }
  const [clickedLatitude, clickedLongitude] = clickedCoordinates;

  // Request forecast data for the clicked location.
  const { forecast, relativeLocation } =
    await requestForecastWithRelativeLocation(
      clickedLatitude,
      clickedLongitude,
    );

  // Stop if forecast properties are missing.
  if (!forecast?.data?.properties) {
    return;
  }

  // Clone forecast data to avoid mutating the original response.
  const structuredForecastData = structuredClone(forecast.data);

  // Flatten nested forecast properties.
  structuredForecastData.properties = processProperties(
    forecast.data.properties,
  );

  // Add relative location properties to the forecast for use in popups.
  structuredForecastData.properties.relativeLocation_city =
    relativeLocation.city;
  structuredForecastData.properties.relativeLocation_state =
    relativeLocation.state;

  const forecastTitle = formatForecastTitle(
    relativeLocation,
    clickedLatitude,
    clickedLongitude,
  );

  // Create a Blob from the processed data.
  const blob = new Blob([JSON.stringify(structuredForecastData)], {
    type: "application/geo+json",
  });

  // Create an object URL for the Blob.
  const url = URL.createObjectURL(blob);

  // Revoke the previous forecast layer URL, if present.
  if (state.forecastLayerUrl) {
    URL.revokeObjectURL(state.forecastLayerUrl);
  }

  // Save the new forecast layer URL.
  state.forecastLayerUrl = url;

  // Create the forecast GeoJSON layer.
  state.forecastLayer = new GeoJSONLayer({
    copyright: "NWS",
    popupEnabled: false,
    popupTemplate: {
      content: [
        new CustomContent({
          creator: popupContentCreator,
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
            "relativeLocation_city",
            "relativeLocation_state",
          ],
        }),
      ],
      title: forecastTitle,
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

  // Add the forecast layer to the map.
  viewElement.map?.layers.add(state.forecastLayer);

  // Display popup content using the first forecast graphic.
  const graphics = await state.forecastLayer.queryFeatures();
  const graphic = graphics.features[0];
  if (!graphic) {
    return;
  }
  featureElement.graphic = graphic;
});

// ---- Functions ----

// Increment the in-flight HTTP request count and update loader visibility.
function beginHttpRequest(): void {
  state.activeHttpRequestCount += 1;
  updateLoaderVisibility();
}

// Check an icon URL with retries and cache the result.
async function checkIconStatus(url: string): Promise<boolean> {
  try {
    for (let attempt = 0; attempt < iconHeadCheckAttempts; attempt++) {
      // Create an AbortController to enforce request timeout.
      const controller = new AbortController();

      // Abort the request if it exceeds the configured timeout.
      const timeoutId = window.setTimeout(() => {
        controller.abort();
      }, requestTimeout);

      try {
        // Send a HEAD request to validate icon availability.
        beginHttpRequest();
        try {
          await request(url, {
            method: "head",
            signal: controller.signal,
          });
        } finally {
          endHttpRequest();
        }

        // Cache successful checks.
        setCachedValue(state.iconStatusCache, url, true, iconCacheTimeToLive);
        return true;
      } catch (error) {
        // Only warn for unexpected failures (not 404 / abort).
        const requestError = error as RequestErrorLike;
        const isAbortError =
          requestError?.name === "AbortError" ||
          /abort/i.test(String(requestError?.message ?? ""));

        if (!isNotFoundError(error) && !isAbortError) {
          console.warn(`Icon availability check failed for ${url}`, error);
        }
      } finally {
        // Clear timeout after the request completes.
        window.clearTimeout(timeoutId);
      }

      // Delay before retrying.
      if (attempt < iconHeadCheckAttempts - 1) {
        await wait(iconHeadRetryDelay);
      }
    }

    // Cache failed checks after all retry attempts.
    setCachedValue(
      state.iconStatusCache,
      url,
      false,
      iconFailureCacheTimeToLive,
    );
    return false;
  } finally {
    // Clear in-flight icon check state.
    state.inFlightIconChecks.delete(url);
  }
}

// Create or refresh the observation stations layer from the current view center.
async function createObservationStationsLayer(): Promise<void> {
  // Read center coordinates.
  const centerLatitude = viewElement.center?.latitude;
  const centerLongitude = viewElement.center?.longitude;

  // Validate center coordinates before requesting data.
  const centerCoordinates = tryGetFiniteCoordinates(
    centerLatitude,
    centerLongitude,
  );
  if (!centerCoordinates) {
    console.error("View center coordinates are invalid.");
    return;
  }
  const [validatedCenterLatitude, validatedCenterLongitude] = centerCoordinates;

  // Build a key for deduplicating center-based station refreshes.
  const observationStationsKey = `${normalizeCoordinate(validatedCenterLatitude)},${normalizeCoordinate(validatedCenterLongitude)}`;
  if (
    observationStationsKey === state.lastObservationStationsKey ||
    observationStationsKey === state.inFlightObservationStationsKey
  ) {
    return;
  }

  // Mark this center key as in flight.
  state.inFlightObservationStationsKey = observationStationsKey;

  try {
    // Request NWS points for the current center.
    const nwsPoints = await requestPoints(
      validatedCenterLatitude,
      validatedCenterLongitude,
    );
    const observationStationsUrlValue =
      nwsPoints?.data?.properties?.observationStations;

    // Stop if points data does not include a stations URL.
    if (
      typeof observationStationsUrlValue !== "string" ||
      !observationStationsUrlValue
    ) {
      return;
    }

    // Request observation stations from the points response URL.
    const observationStations = await requestObservationStations(
      observationStationsUrlValue,
    );

    // Stop if station features are missing.
    if (!observationStations?.data?.features) {
      return;
    }

    // Clone station data to avoid mutating the original response.
    const structuredStationData = structuredClone(observationStations.data);

    // Enrich each feature with latest observations and forecast data.
    const stationFeatures = structuredStationData.features;
    if (!Array.isArray(stationFeatures)) {
      return;
    }

    const featureEnrichmentPromises = stationFeatures.map(
      async (feature: GeoJSONFeature) => {
        try {
          // Read station identifier and feature coordinates.
          const stationIdentifier = String(
            feature?.properties?.stationIdentifier ?? "",
          ).trim();
          const [longitude, latitude] = feature?.geometry?.coordinates ?? [];

          // Skip features without a station identifier.
          if (!stationIdentifier) {
            console.warn(
              "Skipping feature with missing stationIdentifier",
              feature,
            );
            return;
          }

          // Request latest observations and forecast in parallel.
          const featureCoordinates = tryGetFiniteCoordinates(
            Number(latitude),
            Number(longitude),
          );
          const [observationProperties, forecastProperties] = await Promise.all(
            [
              requestLatestObservations(stationIdentifier),
              featureCoordinates
                ? requestForecast(featureCoordinates[0], featureCoordinates[1])
                : Promise.resolve(null),
            ],
          );

          // Flatten and merge observation and forecast properties into the feature.
          feature.properties = processProperties({
            ...feature.properties,
            ...(observationProperties?.data?.properties ?? {}),
            ...(forecastProperties?.data?.properties ?? {}),
          });
        } catch (error) {
          // Log feature-level errors and continue processing.
          const failedStationIdentifier = String(
            feature?.properties?.stationIdentifier ?? "unknown",
          );
          console.error(
            `Failed to process data for feature with stationIdentifier ${failedStationIdentifier}`,
            error,
          );
        }
      },
    );

    // Wait for all feature enrichment to finish.
    await Promise.all(featureEnrichmentPromises);

    // Create a Blob from the processed data.
    const blob = new Blob([JSON.stringify(structuredStationData)], {
      type: "application/geo+json",
    });

    // Create an object URL for the Blob.
    const url = URL.createObjectURL(blob);

    // Revoke the previous stations layer URL, if present.
    if (state.observationStationsLayerUrl) {
      URL.revokeObjectURL(state.observationStationsLayerUrl);
    }

    // Save the new stations layer URL.
    state.observationStationsLayerUrl = url;

    // Create a GeoJSON layer from the processed stations data.
    const observationStationsLayer = new GeoJSONLayer({
      copyright: "NWS",
      popupEnabled: true,
      popupTemplate: {
        content: [
          new CustomContent({
            creator: popupContentCreator,
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
          }),
        ],
        title: "{name} ({stationIdentifier})",
      },
      title: "NWS Observation Stations",
      url,
    });

    // Create a renderer for observation stations.
    const { renderer } = await createRenderer({
      field: "icon",
      layer: observationStationsLayer,
      view: viewElement.view,
    });

    // Build symbols for valid icon URLs and drop invalid entries.
    const uniqueValueInfos = renderer.uniqueValueInfos ?? [];
    renderer.uniqueValueInfos = (
      await Promise.all(
        uniqueValueInfos.map(async (info) => {
          // Read icon URL from the unique value.
          const iconUrl = String(info.value ?? "").trim();

          // Only create symbols for icon URLs that respond with HTTP 200.
          const iconIsAvailable = await isHttp200(iconUrl);

          if (!iconIsAvailable) {
            return null;
          }

          // Assign a CIM symbol based on the icon URL.
          info.symbol = createObservationStationsSymbol(iconUrl);
          return info;
        }),
      )
    ).filter((info): info is NonNullable<typeof info> => info !== null);

    // Use a default symbol when no valid icon URL is available.
    renderer.defaultSymbol = createObservationStationsSymbol(
      "https://sagewall.github.io/test-images/weather-station.png",
    );

    // Assign the renderer to the stations layer.
    observationStationsLayer.renderer = renderer;

    // Remove any previous stations layer.
    if (state.observationStationsLayer) {
      viewElement.map?.layers.remove(state.observationStationsLayer);
    }

    // Save the new layer reference.
    state.observationStationsLayer = observationStationsLayer;

    // Add the new layer to the map.
    viewElement.map?.layers.add(state.observationStationsLayer);

    // Mark this center key as refreshed after layer creation succeeds.
    state.lastObservationStationsKey = observationStationsKey;
  } finally {
    // Clear the in-flight key only if this invocation still owns it.
    if (state.inFlightObservationStationsKey === observationStationsKey) {
      state.inFlightObservationStationsKey = "";
    }
  }
}

// Create a CIM symbol for observation stations from an icon URL.
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

// Create a forecast/current-conditions list item and optional icon.
function createPopupListItem(
  label: string,
  description: string,
  iconUrl: string,
  iconAlt: string,
): HTMLCalciteListItemElement {
  const listItem = document.createElement("calcite-list-item");
  listItem.label = label;
  listItem.description = description;

  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = iconAlt;
    img.style.maxWidth = "86px";
    img.slot = "content-start";
    listItem.appendChild(img);
  }

  return listItem;
}

// Decrement the in-flight HTTP request count.
function endHttpRequest(): void {
  if (state.activeHttpRequestCount > 0) {
    state.activeHttpRequestCount -= 1;
  }
  updateLoaderVisibility();
}

// Build a forecast popup title with relative-location fallback.
function formatForecastTitle(
  relativeLocation: RelativeLocation,
  latitude: number,
  longitude: number,
): string {
  const city = relativeLocation.city.trim();
  const state = relativeLocation.state.trim();

  if (city && state) {
    return `Forecast for ${city}, ${state}`;
  }

  if (city) {
    return `Forecast for ${city}`;
  }

  return `Forecast for ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
}

// Read a cached value and evict expired entries.
function getCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | null {
  // Read the cache entry.
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  // Evict expired entries.
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  // Return the cached value.
  return entry.value;
}

// Convert unknown input to a finite number when possible.
function getFiniteNumberOrNull(value: unknown): number | null {
  const parsedNumber = Number(value);
  return Number.isFinite(parsedNumber) ? parsedNumber : null;
}

// Parse and normalize relative location from a points response.
function getRelativeLocationFromPoints(
  points: ApiResponse | null,
): RelativeLocation {
  // NWS points payload nests relative location under an untyped properties object.
  const properties = (
    points?.data?.properties?.relativeLocation as {
      properties?: unknown;
    } | null
  )?.properties;
  if (!properties || typeof properties !== "object") {
    return emptyRelativeLocation;
  }

  const { city, state } = properties as { city?: unknown; state?: unknown };
  return {
    city: getTrimmedStringOrEmpty(city),
    state: getTrimmedStringOrEmpty(state),
  };
}

// Convert unknown input to a trimmed string when the input is a string.
function getTrimmedStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Check whether a URL returns HTTP 200, with caching.
async function isHttp200(url: string): Promise<boolean> {
  const normalizedUrl = getTrimmedStringOrEmpty(url);

  // Reject empty URLs.
  if (!normalizedUrl) {
    return false;
  }

  // Only check absolute HTTP(S) URLs.
  if (
    !normalizedUrl.startsWith("http://") &&
    !normalizedUrl.startsWith("https://")
  ) {
    return false;
  }

  // Return cached status when available.
  const cached = getCachedValue(state.iconStatusCache, normalizedUrl);
  if (cached !== null) {
    return cached;
  }

  // Reuse any in-flight check for this URL.
  const inFlight = state.inFlightIconChecks.get(normalizedUrl);
  if (inFlight) {
    return inFlight;
  }

  // Start a new icon status check.
  const checkPromise = checkIconStatus(normalizedUrl);

  // Track the in-flight check for deduplication.
  state.inFlightIconChecks.set(normalizedUrl, checkPromise);

  // Return the shared check promise.
  return checkPromise;
}

// Determine whether an error represents HTTP 404.
function isNotFoundError(error: unknown): boolean {
  // Read status details from the request error.
  const requestError = error as RequestErrorLike;
  const status = requestError?.details?.httpStatus ?? requestError?.httpStatus;

  // Return true if status is 404 or, as a fallback, if message contains "404".
  return (
    Number(status) === 404 ||
    /\b404\b/.test(String(requestError?.message ?? ""))
  );
}

// Normalize coordinates for stable cache keys.
function normalizeCoordinate(value: number): string {
  return value.toFixed(4);
}

// Perform a network request and maintain request bookkeeping.
async function performRequest(
  cacheKey: string,
  url: string,
): Promise<ApiResponse | null> {
  try {
    // Execute the JSON request with configured headers and timeout.
    beginHttpRequest();
    const response = await request(url, {
      headers,
      responseType: "json",
      timeout: requestTimeout,
    });
    state.failedRequestCache.delete(cacheKey);
    return response;
  } catch (error) {
    // Cache recent failures to avoid immediate retries.
    setCachedValue(
      state.failedRequestCache,
      cacheKey,
      true,
      failedRequestCacheTimeToLive,
    );

    // Log non-404 failures.
    if (!isNotFoundError(error)) {
      console.error(`Request failed for ${url}`, error);
    }
    return null;
  } finally {
    endHttpRequest();

    // Clear in-flight state for this key.
    state.inFlightRequests.delete(cacheKey);
  }
}

// Create custom popup content for forecast and station features.
function popupContentCreator(
  event: PopupTemplateCreatorEvent,
): HTMLCalciteListElement {
  // Read attributes from the popup graphic.
  const attributes = event.graphic.attributes;

  // Build the list container.
  const list = document.createElement("calcite-list");

  // Add current conditions when temperature or description is available.
  const temperatureValue = getFiniteNumberOrNull(attributes.temperature_value);
  const textDescription = getTrimmedStringOrEmpty(attributes.textDescription);
  if (temperatureValue !== null || textDescription) {
    const temperature =
      temperatureValue !== null ? (temperatureValue * 9) / 5 + 32 : null;
    const description = `${textDescription ? textDescription + " " : "Unknown "}${temperature !== null ? temperature.toFixed(1) + " °F" : ""}`;
    const currentConditionsIcon = getTrimmedStringOrEmpty(attributes.icon);
    const currentConditionsListItem = createPopupListItem(
      "Current Conditions",
      description,
      currentConditionsIcon,
      textDescription || "Current Conditions Icon",
    );

    // Add current conditions to the list.
    list.appendChild(currentConditionsListItem);
  }

  // Add up to six forecast period items.
  for (let i = 0; i < 6; i++) {
    const periodName = getTrimmedStringOrEmpty(attributes[`periods_${i}_name`]);
    const periodForecast = getTrimmedStringOrEmpty(
      attributes[`periods_${i}_detailedForecast`],
    );
    const periodIcon = getTrimmedStringOrEmpty(attributes[`periods_${i}_icon`]);

    const forecastListItem = createPopupListItem(
      periodName || `Period ${i + 1}`,
      periodForecast || "No forecast available",
      periodIcon,
      periodForecast || `Icon for Period ${i + 1}`,
    );

    list.appendChild(forecastListItem);
  }

  // Return the populated list.
  return list;
}

// Recursively flatten nested object and array properties.
function processProperties(
  object: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  // Accumulate flattened key-value pairs.
  const result: Record<string, string> = {};

  // Flatten each key-value pair based on value type.
  for (const [key, value] of Object.entries(object)) {
    const newKey = prefix ? `${prefix}_${key}` : key;

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemKey = `${newKey}_${index}`;
        if (item && typeof item === "object") {
          Object.assign(
            result,
            processProperties(item as Record<string, unknown>, itemKey),
          );
          // Return from this callback iteration after recursively flattening.
          return;
        }

        result[itemKey] = String(item);
      });
      continue;
    }

    if (value && typeof value === "object") {
      Object.assign(
        result,
        processProperties(value as Record<string, unknown>, newKey),
      );
      continue;
    }

    result[newKey] = value == null ? "" : String(value);
  }

  // Return flattened properties.
  return result;
}

// Remove the existing forecast layer and clear related UI state.
function removeExistingForecastLayer(): void {
  // Remove any existing forecast layer.
  if (state.forecastLayer) {
    viewElement.map?.layers.remove(state.forecastLayer);
    state.forecastLayer = null;
  }

  // Release any previous object URL backing the forecast layer.
  if (state.forecastLayerUrl) {
    URL.revokeObjectURL(state.forecastLayerUrl);
    state.forecastLayerUrl = "";
  }

  // Clear popup graphic state.
  featureElement.graphic = null;
}

// Request forecast data by latitude/longitude.
async function requestForecast(
  latitude: number,
  longitude: number,
): Promise<ApiResponse | null> {
  return (await requestForecastWithRelativeLocation(latitude, longitude))
    .forecast;
}

// Request forecast data by URL.
async function requestForecastByUrl(
  forecastUrl: string,
): Promise<ApiResponse | null> {
  const normalizedForecastUrl = getTrimmedStringOrEmpty(forecastUrl);

  // Reject empty forecast URLs.
  if (!normalizedForecastUrl) {
    return null;
  }

  const cacheKey = `forecast:${normalizedForecastUrl}`;
  return requestWithCache(
    state.forecastCache,
    cacheKey,
    normalizedForecastUrl,
    forecastCacheTimeToLive,
  );
}

// Request forecast data and relative location by latitude/longitude.
async function requestForecastWithRelativeLocation(
  latitude: number,
  longitude: number,
): Promise<{
  forecast: ApiResponse | null;
  relativeLocation: RelativeLocation;
}> {
  const coordinates = tryGetFiniteCoordinates(latitude, longitude);
  if (!coordinates) {
    return {
      forecast: null,
      relativeLocation: emptyRelativeLocation,
    };
  }
  const [validatedLatitude, validatedLongitude] = coordinates;

  // Request points data, then read the forecast URL.
  const points = await requestPoints(validatedLatitude, validatedLongitude);
  const forecastUrlValue = points?.data?.properties?.forecast;
  const relativeLocation = getRelativeLocationFromPoints(points);

  // Stop when points response has no forecast URL.
  if (typeof forecastUrlValue !== "string" || !forecastUrlValue) {
    return {
      forecast: null,
      relativeLocation,
    };
  }

  // Request forecast data by URL.
  return {
    forecast: await requestForecastByUrl(forecastUrlValue),
    relativeLocation,
  };
}

// Request latest observations for a station.
async function requestLatestObservations(
  stationIdentifier: string,
): Promise<ApiResponse | null> {
  const normalizedStationIdentifier =
    getTrimmedStringOrEmpty(stationIdentifier);

  // Reject empty station identifiers.
  if (!normalizedStationIdentifier) {
    return null;
  }

  // Build the latest observations URL.
  const url = `https://api.weather.gov/stations/${normalizedStationIdentifier}/observations/latest`;

  const cacheKey = `observations:${normalizedStationIdentifier}`;
  return requestWithCache(
    state.latestObservationsCache,
    cacheKey,
    url,
    observationsCacheTimeToLive,
  );
}

// Request observation stations from a points-derived URL.
async function requestObservationStations(
  observationStationsUrl: string,
): Promise<ApiResponse | null> {
  const normalizedObservationStationsUrl = getTrimmedStringOrEmpty(
    observationStationsUrl,
  );

  // Reject empty stations URLs.
  if (!normalizedObservationStationsUrl) {
    return null;
  }

  const cacheKey = `stations:${normalizedObservationStationsUrl}`;
  return requestWithCache(
    state.observationStationsCache,
    cacheKey,
    normalizedObservationStationsUrl,
    pointsStationsCacheTimeToLive,
  );
}

// Request NWS points data by latitude/longitude.
async function requestPoints(
  latitude: number,
  longitude: number,
): Promise<ApiResponse | null> {
  const coordinates = tryGetFiniteCoordinates(latitude, longitude);
  if (!coordinates) {
    return null;
  }
  const [validatedLatitude, validatedLongitude] = coordinates;

  // Normalize coordinates for a stable cache key.
  const normalizedLatitude = normalizeCoordinate(validatedLatitude);
  const normalizedLongitude = normalizeCoordinate(validatedLongitude);
  const cacheKey = `points:${normalizedLatitude},${normalizedLongitude}`;

  return requestWithCache(
    state.pointsCache,
    cacheKey,
    `https://api.weather.gov/points/${normalizedLatitude},${normalizedLongitude}`,
    pointsStationsCacheTimeToLive,
  );
}

// Resolve a request via cache + deduplicated network fallback.
async function requestWithCache(
  cache: Map<string, CacheEntry<ApiResponse>>,
  cacheKey: string,
  url: string,
  ttlMs: number,
): Promise<ApiResponse | null> {
  // Return a fresh cached response when available.
  const cached = getCachedValue(cache, cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Otherwise request the resource and cache successful responses.
  const response = await requestWithDeduplication(cacheKey, url);
  if (!response) {
    return null;
  }

  setCachedValue(cache, cacheKey, response, ttlMs);

  return response;
}

// Deduplicate concurrent requests by cache key.
async function requestWithDeduplication(
  cacheKey: string,
  url: string,
): Promise<ApiResponse | null> {
  // Skip immediate retry for recently failed keys.
  if (getCachedValue(state.failedRequestCache, cacheKey) === true) {
    return null;
  }

  // Reuse existing in-flight request promises.
  const inFlightRequest = state.inFlightRequests.get(cacheKey);
  if (inFlightRequest) {
    return inFlightRequest;
  }

  // Start the underlying network request.
  const requestPromise = performRequest(cacheKey, url);

  // Track in-flight request for this key. Cleanup happens in performRequest finally.
  state.inFlightRequests.set(cacheKey, requestPromise);

  // Return the shared request promise.
  return requestPromise;
}

// Cache a value with a TTL.
function setCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): void {
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

// Validate coordinate inputs and return normalized numbers.
function tryGetFiniteCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): [number, number] | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return [Number(latitude), Number(longitude)];
}

// Keep loader visibility in sync with in-flight HTTP requests.
function updateLoaderVisibility(): void {
  if (!loaderElement) {
    return;
  }
  loaderElement.hidden = state.activeHttpRequestCount <= 0;
}

// Sleep for the provided number of milliseconds.
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
