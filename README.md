# KIWIPRIMER

This project reads data from a Google Sheet and scrapes Facebook profiles using Playwright.

## Setup

1. **Clone the repository:**
   ```sh
   git clone https://github.com/mriosssss2/tassy.git
   cd tassy
   ```
2. **Install dependencies:**
   ```sh
   npm install
   ```
3. **Create a `.env` file:**
   Add your Google Sheet ID and API key:
   ```env
   SHEET_ID=your_google_sheet_id
   API_KEY=your_google_api_key
   ```
4. **Run the script:**
   ```sh
   node readGoogleSheet.js
   ```

## Notes
- You need Node.js installed.
- Make sure your Google Sheet is accessible with the provided API key.
- Playwright will download browser binaries on first run.

## License
ISC
