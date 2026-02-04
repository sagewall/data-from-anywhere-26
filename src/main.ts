import WebMap from "@arcgis/core/WebMap";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer";
import { CustomContent } from "@arcgis/core/popup/content";
import SimpleRenderer from "@arcgis/core/renderers/SimpleRenderer";
import request from "@arcgis/core/request";
import WebStyleSymbol from "@arcgis/core/symbols/WebStyleSymbol";
import "@arcgis/map-components/components/arcgis-map";
import "@esri/calcite-components/components/calcite-shell";
import "./style.css";

const viewElement = document.querySelector(
  "arcgis-map",
)! as HTMLArcgisMapElement;

const webMap = new WebMap({
  basemap: "topo-vector",
});

viewElement.map = webMap;

viewElement.constraints.minZoom = 9;
viewElement.constraints.maxZoom = 15;

await viewElement.viewOnReady();

viewElement.addEventListener("arcgisViewChange", () => {
  if (viewElement.stationary) {
    nwsPointsRequest();
  }
});

async function nwsPointsRequest(): Promise<void> {
  const nwsPointsRequest = await request(
    `https://api.weather.gov/points/${viewElement.center.latitude},${viewElement.center.longitude}`,
    {
      headers: {
        accept: "application/geo+json",
        "User-Agent": "data-from-anywhere-26",
      },
    },
  );

  const observationStationsRequest = await request(
    nwsPointsRequest.data.properties.observationStations,
    {
      headers: {
        accept: "application/geo+json",
        "User-Agent": "data-from-anywhere-26",
      },
    },
  );

  const data = structuredClone(observationStationsRequest.data);

  const allFeaturePromises = data.features.map(async (feature: any) => {
    const processedProperties = processProperties(feature.properties);
    feature.properties = processedProperties;

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
    await Promise.all([requestLatestObservations(), requestForecast()]);
  });
  await Promise.all(allFeaturePromises);

  const blob = new Blob([JSON.stringify(data)], {
    type: "application/geo+json",
  });

  const url = URL.createObjectURL(blob);

  viewElement.map?.layers.removeAll();

  const observationStationsLayer = new GeoJSONLayer({
    title: "NWS Observation Stations",
    url,
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
            const description = `${textDescription ? textDescription + ", " : ""}${temperature ? temperature.toFixed(1) + " °F" : ""}`;
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
  });

  viewElement.map?.layers.add(observationStationsLayer);
}

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
