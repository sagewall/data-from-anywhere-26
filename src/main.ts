import WebMap from "@arcgis/core/WebMap.js";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import CustomContent from "@arcgis/core/popup/content/CustomContent.js";
import SimpleRenderer from "@arcgis/core/renderers/SimpleRenderer.js";
import request from "@arcgis/core/request.js";
import WebStyleSymbol from "@arcgis/core/symbols/WebStyleSymbol.js";
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-search";
import "@esri/calcite-components/components/calcite-shell";
import "./style.css";

const userAgent = "data-from-anywhere-26";

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
    nwsPointsRequest();
  }
});

// Function to handle NWS Points request and subsequent data processing
async function nwsPointsRequest(): Promise<void> {
  if (!viewElement.center) {
    console.error("View center is not defined.");
    return;
  }
  const { latitude, longitude } = viewElement.center;
  if (!latitude || !longitude) {
    console.error("View center latitude or longitude is not defined.");
    return;
  }
  const nwsPoints = await requestPoints(latitude, longitude);

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
          ...observationProperties.data.properties,
          ...forecastProperties.data.properties,
        });
      } catch (error) {
        console.error(
          `Failed to process data for feature with stationIdentifier ${feature.properties.stationIdentifier}`,
          error,
        );
      }
    },
  );

  // // Wait for all feature data to be requested and processed
  await Promise.all(allFeaturePromises);

  // Create a Blob from the processed data
  const blob = new Blob([JSON.stringify(structuredStationData)], {
    type: "application/geo+json",
  });

  // Create a URL for the Blob
  const url = URL.createObjectURL(blob);

  // Remove existing layers before adding the new one
  viewElement.map?.layers.removeAll();

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
          creator: async (event) => {
            const attributes = event.graphic.attributes;

            const list = document.createElement("calcite-list");

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

            for (let i = 0; i < 6; i++) {
              const forecastListItem =
                document.createElement("calcite-list-item");
              forecastListItem.label = attributes[`periods_${i}_name`]
                ? attributes[`periods_${i}_name`]
                : `Period ${i + 1}`;
              forecastListItem.description = attributes[
                `periods_${i}_detailedForecast`
              ]
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
          },
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

  // Add the new layer to the map
  viewElement.map?.layers.add(observationStationsLayer);
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
        headers: {
          accept: "application/geo+json",
          "User-Agent": userAgent,
        },
      },
    );
    return await request(points.data.properties.forecast, {
      headers: {
        accept: "application/geo+json",
        "User-Agent": userAgent,
      },
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
        headers: {
          accept: "application/geo+json",
          "User-Agent": userAgent,
        },
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
      headers: {
        accept: "application/geo+json",
        "User-Agent": userAgent,
      },
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
        headers: {
          accept: "application/geo+json",
          "User-Agent": userAgent,
        },
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
