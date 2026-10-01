name: Live momentum
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:
concurrency:
  group: live
  cancel-in-progress: false
jobs:
  live:
    runs-on: ubuntu-latest
    timeout-minutes: 350
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: node scripts/live.js
        env:
          API_KEY: ${{ secrets.API_KEY }}
          FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
