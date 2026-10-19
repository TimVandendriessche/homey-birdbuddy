# Bird Buddy (unofficial) voor Homey

Versie 0.6.0. Functies:
- Batterijpercentage
- Foto van de laatste bezoeker op het apparaat
- Flow-trigger "Er is een nieuwe bezoeker" (met foto en tijdstip)
- Flow-voorwaarde "Er was een bezoeker in de laatste X minuten"
- Video van de laatste bezoeker (op het apparaat en in de widget)
- Dashboard-widget "Laatste bezoeker"
- Instelbaar controle-interval (standaard 15 minuten)

## Installeren
1. `npm install --global homey` en `homey login` (en eventueel `homey select`)
2. In deze map: `homey app run --remote` (testen) of `homey app install`

Vereist Homey Pro met firmware 12.3.0 of nieuwer (nodig voor de widget). Niet voor Homey Cloud.

## Let op
- Dit project gebruikt Homey Compose: `app.json` wordt automatisch gegenereerd uit `.homeycompose/`,
  `drivers/feeder/driver.compose.json` en `widgets/`. Bewerk dus niet `app.json`.
- Onofficiële API: de Bird Buddy-koppeling zit in `lib/birdbuddy.js`.
- Je Bird Buddy-wachtwoord wordt niet bewaard: alleen inlogtokens. Verloopt de login, gebruik dan "Herstel" bij het apparaat.
