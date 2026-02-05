# Data From Anywhere 26

A demo web application for the Esri Developer & Technology Summit showcasing interactive mapping and real-time weather data using GeoJSON layers and the National Weather Service (NWS) API.

## View Live

https://sagewall.github.io/data-from-anywhere-26/

## Features

- Interactive map with Esri ArcGIS Web Components
- Displays NWS observation stations and real-time weather forecasts
- Click anywhere on the map to get a detailed forecast for that location
- Popups show current conditions and multi-period forecasts
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
- Click on the map to view a weather forecast for that location.
- Observation stations are shown with custom icons; click them for current conditions and forecasts.

## Project Structure

- `src/` — Main application code (TypeScript, CSS)
- `public/` — Static assets
- `index.html` — Main HTML file
- `vite.config.js` — Vite configuration
- `tsconfig.json` — TypeScript configuration

## License

This demo is for educational purposes at the Esri Developer & Technology Summit.

## Acknowledgments

- Esri ArcGIS and Calcite teams
- National Weather Service API
