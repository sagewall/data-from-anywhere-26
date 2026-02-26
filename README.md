# Data From Anywhere 26

A demo web application for the Esri Developer & Technology Summit showcasing interactive mapping and real-time weather data using GeoJSON layers and the National Weather Service (NWS) API.

## View Live

https://sagewall.github.io/data-from-anywhere-26/

## Features

- Interactive map with Esri ArcGIS Web Components
- Dynamic NWS observation-station layer refreshes as the map view changes
- Click a station for current conditions plus multi-period forecast details
- Click anywhere on the map to generate a forecast polygon for that location
- Popups combine current conditions, forecast periods, and weather icons
- Relative-location aware forecast titles (city/state when available)
- Loader state tied to active HTTP requests for better network feedback
- Request deduplication and TTL-based caching for points, stations, observations, and forecasts
- Icon availability checks with retry + short failure cache to avoid broken popup imagery
- Uses modern web technologies (Vite, TypeScript, Calcite Design System)

## Technologies Used

- [ArcGIS Map Components](https://developers.arcgis.com/map-components/)
- [Esri Calcite Components](https://developers.arcgis.com/calcite-design-system/)
- [National Weather Service API](https://www.weather.gov/documentation/services-web-api)
- TypeScript, Vite

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- npm

### Installation

1. Clone the repository:
   ```sh
   git clone <repo-url>
   cd data-from-anywhere-26
   ```
2. Install dependencies:
   ```sh
   npm install
   ```

### Running the Application

Start the development server:

```sh
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```sh
npm run build
```

## Usage

- Pan and zoom the map to explore different areas.
- Observation stations refresh based on the current map center once navigation settles.
- Click on a station to view current conditions and up to six forecast periods.
- Click elsewhere on the map to view the forecast for that location.
- Use the information action in the top navigation to open the in-app About dialog.

## Data Flow Highlights

- NWS `points` responses are used to discover both forecast and observation-station endpoints.
- Station features are enriched with latest observations and forecast data before rendering.
- Nested API properties are flattened into popup-friendly attributes at runtime.
- In-flight request tracking prevents duplicate network calls for the same cache key.
- Failed requests are briefly cached to reduce immediate retry storms.

## Project Structure

- `src/` — Main application code (TypeScript, CSS)
- `public/` — Static assets
- `index.html` — Main HTML file
- `vite.config.js` — Vite configuration
- `tsconfig.json` — TypeScript configuration

## Notes

- Weather data is provided by the NWS Weather API and can be subject to service availability and rate limits.
- This demo is optimized for learning ArcGIS map components, request handling, and GeoJSONLayer workflows.

## License

Apache License, Version 2.0

## Acknowledgments

- Esri ArcGIS and Calcite teams
- National Weather Service API
