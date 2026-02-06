import Color from "@arcgis/core/Color.js";
import WebMap from "@arcgis/core/WebMap.js";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import CustomContent from "@arcgis/core/popup/content/CustomContent.js";
import SimpleRenderer from "@arcgis/core/renderers/SimpleRenderer.js";
import request from "@arcgis/core/request.js";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol.js";
import WebStyleSymbol from "@arcgis/core/symbols/WebStyleSymbol.js";
import "@arcgis/map-components/components/arcgis-feature";
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-search";
import "@esri/calcite-components/components/calcite-shell";
import "./style.css";

// Application state to keep track of layers
const state = {
  forecastLayer: null as GeoJSONLayer | null,
  observationStationsLayer: null as GeoJSONLayer | null,
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
  if (
    !viewElement.center ||
    !viewElement.center.latitude ||
    !viewElement.center.longitude
  ) {
    console.error("View center is not defined.");
    return;
  }

  // Request NWS points data for the current view center
  const nwsPoints = await requestPoints(
    viewElement.center.latitude,
    viewElement.center.longitude,
  );

  // Request observation stations using the URL from the NWS points data
  const observationStations = await requestObservationStations(
    nwsPoints.data.properties.observationStations,
  );

  // Deep clone the data to avoid mutating the original response
  const structuredStationData = structuredClone(observationStations.data);

  // Process each feature to get latest observations and forecast data
  const allFeaturePromises = structuredStationData.features.map(
    async (feature: any) => {
      try {
        const [observationProperties, forecastProperties] = await Promise.all([
          requestLatestObservations(feature.properties.stationIdentifier),
          requestForecast(
            feature.geometry.coordinates[1],
            feature.geometry.coordinates[0],
          ),
        ]);
        feature.properties = processProperties({
          ...feature.properties,
          ...observationProperties.data?.properties,
          ...forecastProperties.data?.properties,
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
    renderer: new SimpleRenderer({
      symbol: new WebStyleSymbol({
        name: "Radio Tower_Large_3",
        styleUrl:
          "https://www.arcgis.com/sharing/rest/content/items/37da62fcdb854f8e8305c79e8b5023dc/data",
      }),
    }),
    title: "NWS Observation Stations",
    url,
  });

  // If there's an existing observation stations layer, remove it before adding the new one
  if (state.observationStationsLayer) {
    viewElement.map?.layers.remove(state.observationStationsLayer);
  }

  // Update the state with the new layer reference
  state.observationStationsLayer = observationStationsLayer;

  // Add the new layer to the map if it is not null
  viewElement.map?.layers.add(state.observationStationsLayer);
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
      img.style.maxWidth = "50px";
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
      img.style.maxWidth = "50px";
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
): Promise<any> {
  try {
    const points = await request(
      `https://api.weather.gov/points/${latitude},${longitude}`,
      {
        headers,
      },
    );
    return await request(points.data.properties.forecast, {
      headers,
    });
    // return processProperties(forecast.data.properties);
  } catch (error) {
    console.error(
      `Failed to process forecast for ${latitude},${longitude}`,
      error,
    );
    return {};
  }
}

// Function to request latest observations for a station
async function requestLatestObservations(
  stationIdentifier: string,
): Promise<any> {
  try {
    return await request(
      `https://api.weather.gov/stations/${stationIdentifier}/observations/latest`,
      {
        headers,
      },
    );
    // return processProperties(observations.data.properties);
  } catch (error) {
    console.error(
      `Failed to process observation for ${stationIdentifier}`,
      error,
    );
    return {};
  }
}

// Function to request observation stations from NWS Points data
async function requestObservationStations(
  observationStationsUrl: string,
): Promise<any> {
  try {
    return await request(observationStationsUrl, {
      headers,
    });
  } catch (error) {
    console.error(
      `Failed to request observation stations from ${observationStationsUrl}`,
      error,
    );
    return {};
  }
}

// Function to request NWS Points data based on latitude and longitude
async function requestPoints(
  latitude: number,
  longitude: number,
): Promise<any> {
  try {
    return await request(
      `https://api.weather.gov/points/${latitude},${longitude}`,
      {
        headers,
      },
    );
  } catch (error) {
    console.error(
      `Failed to request NWS Points data for ${latitude},${longitude}`,
      error,
    );
    return {};
  }
}
