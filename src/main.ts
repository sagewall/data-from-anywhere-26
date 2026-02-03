import WebMap from "@arcgis/core/WebMap";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer";
import request from "@arcgis/core/request";
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

  await Promise.all(
    observationStationsRequest.data.features.map(async (feature: any) => {
      try {
        const processedProperties = processProperties(feature.properties);
        feature.properties = processedProperties;
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
        console.error("Failed to process feature", feature, err);
      }
    }),
  );

  const blob = new Blob([JSON.stringify(observationStationsRequest.data)], {
    type: "application/geo+json",
  });

  const url = URL.createObjectURL(blob);

  viewElement.map?.layers.removeAll();

  const observationStationsLayer = new GeoJSONLayer({
    title: "NWS Observation Stations",
    url,
    popupEnabled: true,
    popupTemplate: {
      title: "{name}",
      content: [
        {
          type: "fields",
          fieldInfos: Object.keys(
            observationStationsRequest.data.features[0].properties,
          ).map((key) => ({
            fieldName: key,
          })),
        },
      ],
    },
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
