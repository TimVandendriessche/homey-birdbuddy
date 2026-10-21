# Bird Buddy (unofficial) voor Homey

Versie 1.1.0. Functies:
- Batterijpercentage
- Foto van de laatste bezoeker op het apparaat
- Flow-trigger "Er is een nieuwe bezoeker" (met foto en tijdstip)
- Flow-voorwaarde "Er was een bezoeker in de laatste X minuten"
- Video van de laatste bezoeker (op het apparaat en in de widget)
- Dashboard-widget "Laatste bezoeker"
- Instelbaar controle-interval (standaard 15 minuten)
- Automatische vogelherkenning, ook voor gratis Bird Buddy-accounts, via hetzelfde verzoek als de knop "Identify this visitor"
- De laatst herkende vogelsoort op het apparaat en in de widget
- Flow-trigger "Er is een vogel herkend" met soortnaam en tijdstip

## Installeren
Open een terminal in de uitgepakte of gekloonde projectmap (waar `package.json` staat), met Node.js en npm geïnstalleerd:

```sh
npm ci
npx homey login
npx homey select
npx homey app run --remote
```

De laatste opdracht start een testsessie. Gebruik `npx homey app install` om de app blijvend te installeren. De Homey CLI genereert daarbij zelf `app.json`.

Vereist Homey Pro met firmware 12.3.0 of nieuwer (nodig voor de widget). Niet voor Homey Cloud.

## Automatische herkenning

De apparaatinstelling **Vogels automatisch herkennen** staat standaard uit. Open in Homey de instellingen van je voederhuisje en schakel deze optie zelf in. Ook bij bestaande apparaten zonder deze instelling blijft herkenning uit; een al opgeslagen keuze blijft behouden. Bij iedere controle leest de app nieuwe ansichtkaarten van het gekoppelde voederhuisje. Als de optie aanstaat, voert de app voor `MANUAL_NOT_STARTED` de handmatige herkenningsaanvraag uit. Een Bird Buddy Premium-abonnement is hiervoor niet nodig als het account de handmatige herkenningsknop kan gebruiken. Reeds herkende vogels veroorzaken geen extra herkenningsaanvraag.

Gebruik **Er is een vogel herkend** voor Flows die een soortnaam nodig hebben. De bestaande bezoeker-trigger blijft direct beschikbaar bij de nieuwe foto, ook als herkenning mislukt. Meerdere soorten staan als kommagescheiden tekst in het token **Vogelsoort**. Daarnaast is het tijdstip van het bezoek beschikbaar. Zonder herkenbare soort gaat de herkennings-trigger niet af.

Als herkenning bij de allereerste controle al aanstaat, wordt alleen de nieuwste wachtende bezoeker herkend, zonder historische Flows te starten. Schakel je de optie later in, dan worden nieuwe bezoekers vanaf de volgende controle verwerkt; eerder overgeslagen ansichtkaarten worden niet alsnog herkend. Daarna worden alle nieuwe ansichtkaarten meegenomen via paginering. Per controle worden maximaal vijf herkenningsopdrachten verwerkt. Een wachtrij en controlepunt worden bewaard bij een herstart. Tijdelijke fouten worden met oplopende wachttijd tot vijf keer geprobeerd; de app respecteert wachttijden van de server. Herkenning slaat ansichtkaarten niet op in de Bird Buddy-collectie en deelt ze niet.

De controle-interval bepaalt de vertraging: dit is geen detectie op het moment dat de vogel landt. Schakel automatische herkenning uit in de apparaatinstellingen om geen nieuwe herkenningsaanvragen te doen. De foto, batterij en herkenning door Bird Buddy Premium blijven werken. Reeds wachtende opdrachten worden gepauzeerd.

## Ontwikkelen en testen

```sh
npm ci
npm test
npm run validate
```

De tests gebruiken nagebootste API-antwoorden; er zijn geen inloggegevens nodig. De GraphQL-verzoeken zijn gecontroleerd tegen het schemasnapshot van de communityclient pybirdbuddy. De exacte bronnen voor veldnamen, herkenningsmutation en videoargumenten staan in [API-bronnen](docs/birdbuddy-api.md). De uiteindelijke werking en eventuele accountlimieten moeten ook met een echt gratis account en Homey Pro worden getest.

## Let op
- Dit project gebruikt Homey Compose: `app.json` wordt automatisch gegenereerd uit `.homeycompose/`,
  `drivers/feeder/driver.compose.json` en `widgets/`. Bewerk alleen de Compose-bronnen en voer daarna `npm run validate` uit. Het gegenereerde bestand blijft in Git, omdat Homey CLI 4.6.0 het bij het starten vereist.
- Onofficiële API: de Bird Buddy-koppeling zit in `lib/birdbuddy.js`.
- Je Bird Buddy-wachtwoord wordt niet bewaard: alleen inlogtokens. Verloopt de login, gebruik dan "Herstel" bij het apparaat.
- Deze app gebruikt rechtstreeks GraphQL vanuit Node.js; een Python-service of Android-app is niet nodig.
