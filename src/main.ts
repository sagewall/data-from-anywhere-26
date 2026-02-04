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

// Set zoom constraints
viewElement.constraints.minZoom = 9;
viewElement.constraints.maxZoom = 15;

// Wait for the view to be ready before making requests
await viewElement.viewOnReady();

// Event listener for when the view extent changes
viewElement.addEventListener("arcgisViewChange", () => {
  if (viewElement.stationary) {
    nwsPointsRequest();
  }
});

// Function to handle NWS Points request and subsequent data processing
async function nwsPointsRequest(): Promise<void> {
  // Request NWS Points data based on the current center of the view
  const nwsPointsRequest = await request(
    `https://api.weather.gov/points/${viewElement.center.latitude},${viewElement.center.longitude}`,
    {
      headers: {
        accept: "application/geo+json",
        "User-Agent": "data-from-anywhere-26",
      },
    },
  );
  // Request observation stations from the NWS Points data
  const observationStationsRequest = await request(
    nwsPointsRequest.data.properties.observationStations,
    {
      headers: {
        accept: "application/geo+json",
        "User-Agent": "data-from-anywhere-26",
      },
    },
  );

  // Deep clone the data to avoid mutating the original response
  const data = structuredClone(observationStationsRequest.data);

  // Process each feature to get latest observations and forecast data
  const allFeaturePromises = data.features.map(async (feature: any) => {
    const processedProperties = processProperties(feature.properties);
    feature.properties = processedProperties;

    // Request latest observations for the station
    const requestLatestObservations = async () => {
      try {
        const observations = await request(
          `https://api.weather.gov/stations/${processedProperties.stationIdentifier}/observations/latest`,
          {
            headers: {
              accept: "application/geo+json",
              "User-Agent": "data-from-anywhere-26",
            },
          },
        );
        const processedObservationProperties = processProperties(
          observations.data.properties,
        );
        feature.properties = {
          ...feature.properties,
          ...processedObservationProperties,
        };
      } catch (err) {
        console.error(
          "Failed to process observation for feature",
          feature,
          err,
        );
      }
    };

    // Request forecast data for the station
    const requestForecast = async () => {
      try {
        const points = await request(
          `https://api.weather.gov/points/${feature.geometry.coordinates[1]},${feature.geometry.coordinates[0]}`,
          {
            headers: {
              accept: "application/geo+json",
              "User-Agent": "data-from-anywhere-26",
            },
          },
        );
        const forecast = await request(points.data.properties.forecast, {
          headers: {
            accept: "application/geo+json",
            "User-Agent": "data-from-anywhere-26",
          },
        });
        const processedForecastProperties = processProperties(
          forecast.data.properties,
        );
        feature.properties = {
          ...feature.properties,
          ...processedForecastProperties,
        };
      } catch (err) {
        console.error("Failed to process forecast for feature", feature, err);
      }
    };

    // Execute both requests in parallel
    await Promise.all([requestLatestObservations(), requestForecast()]);
  });

  // Wait for all feature data to be requested and processed
  await Promise.all(allFeaturePromises);

  // Create a Blob from the processed data
  const blob = new Blob([JSON.stringify(data)], {
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
