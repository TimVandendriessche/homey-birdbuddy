'use strict';

// Bird Buddy only returns English species names. This list translates the birds that visit
// feeders in Belgium, the Netherlands and nearby. Unknown species keep their English name.
// Columns: English (as returned by Bird Buddy), Dutch, German, French.
const NAMES = [
  ['Great Tit', 'Koolmees', 'Kohlmeise', 'Mésange charbonnière'],
  ['Eurasian Blue Tit', 'Pimpelmees', 'Blaumeise', 'Mésange bleue'],
  ['Coal Tit', 'Zwarte mees', 'Tannenmeise', 'Mésange noire'],
  ['Marsh Tit', 'Glanskop', 'Sumpfmeise', 'Mésange nonnette'],
  ['Willow Tit', 'Matkop', 'Weidenmeise', 'Mésange boréale'],
  ['Crested Tit', 'Kuifmees', 'Haubenmeise', 'Mésange huppée'],
  ['Long-tailed Tit', 'Staartmees', 'Schwanzmeise', 'Mésange à longue queue'],
  ['European Robin', 'Roodborst', 'Rotkehlchen', 'Rougegorge familier'],
  ['Common Blackbird', 'Merel', 'Amsel', 'Merle noir'],
  ['Song Thrush', 'Zanglijster', 'Singdrossel', 'Grive musicienne'],
  ['Mistle Thrush', 'Grote lijster', 'Misteldrossel', 'Grive draine'],
  ['Fieldfare', 'Kramsvogel', 'Wacholderdrossel', 'Grive litorne'],
  ['Redwing', 'Koperwiek', 'Rotdrossel', 'Grive mauvis'],
  ['Eurasian Magpie', 'Ekster', 'Elster', 'Pie bavarde'],
  ['Eurasian Jay', 'Vlaamse gaai', 'Eichelhäher', 'Geai des chênes'],
  ['Western Jackdaw', 'Kauw', 'Dohle', 'Choucas des tours'],
  ['Carrion Crow', 'Zwarte kraai', 'Aaskrähe', 'Corneille noire'],
  ['Hooded Crow', 'Bonte kraai', 'Nebelkrähe', 'Corneille mantelée'],
  ['Rook', 'Roek', 'Saatkrähe', 'Corbeau freux'],
  ['Eurasian Collared Dove', 'Turkse tortel', 'Türkentaube', 'Tourterelle turque'],
  ['Common Wood Pigeon', 'Houtduif', 'Ringeltaube', 'Pigeon ramier'],
  ['Stock Dove', 'Holenduif', 'Hohltaube', 'Pigeon colombin'],
  ['Rock Pigeon', 'Stadsduif', 'Strassentaube', 'Pigeon biset'],
  ['Common Chaffinch', 'Vink', 'Buchfink', 'Pinson des arbres'],
  ['Brambling', 'Keep', 'Bergfink', 'Pinson du Nord'],
  ['European Greenfinch', 'Groenling', 'Grünfink', 'Verdier d\'Europe'],
  ['European Goldfinch', 'Putter', 'Stieglitz', 'Chardonneret élégant'],
  ['Eurasian Siskin', 'Sijs', 'Erlenzeisig', 'Tarin des aulnes'],
  ['Common Linnet', 'Kneu', 'Bluthänfling', 'Linotte mélodieuse'],
  ['Eurasian Bullfinch', 'Goudvink', 'Gimpel', 'Bouvreuil pivoine'],
  ['Hawfinch', 'Appelvink', 'Kernbeißer', 'Grosbec casse-noyaux'],
  ['Common Redpoll', 'Barmsijs', 'Birkenzeisig', 'Sizerin flammé'],
  ['House Sparrow', 'Huismus', 'Haussperling', 'Moineau domestique'],
  ['Eurasian Tree Sparrow', 'Ringmus', 'Feldsperling', 'Moineau friquet'],
  ['Dunnock', 'Heggenmus', 'Heckenbraunelle', 'Accenteur mouchet'],
  ['Eurasian Wren', 'Winterkoning', 'Zaunkönig', 'Troglodyte mignon'],
  ['Eurasian Nuthatch', 'Boomklever', 'Kleiber', 'Sittelle torchepot'],
  ['Eurasian Treecreeper', 'Taigaboomkruiper', 'Waldbaumläufer', 'Grimpereau des bois'],
  ['Short-toed Treecreeper', 'Boomkruiper', 'Gartenbaumläufer', 'Grimpereau des jardins'],
  ['Great Spotted Woodpecker', 'Grote bonte specht', 'Buntspecht', 'Pic épeiche'],
  ['European Green Woodpecker', 'Groene specht', 'Grünspecht', 'Pic vert'],
  ['Lesser Spotted Woodpecker', 'Kleine bonte specht', 'Kleinspecht', 'Pic épeichette'],
  ['Common Starling', 'Spreeuw', 'Star', 'Étourneau sansonnet'],
  ['Eurasian Blackcap', 'Zwartkop', 'Mönchsgrasmücke', 'Fauvette à tête noire'],
  ['Common Chiffchaff', 'Tjiftjaf', 'Zilpzalp', 'Pouillot véloce'],
  ['Goldcrest', 'Goudhaan', 'Wintergoldhähnchen', 'Roitelet huppé'],
  ['Common Firecrest', 'Vuurgoudhaan', 'Sommergoldhähnchen', 'Roitelet à triple bandeau'],
  ['White Wagtail', 'Witte kwikstaart', 'Bachstelze', 'Bergeronnette grise'],
  ['Yellowhammer', 'Geelgors', 'Goldammer', 'Bruant jaune'],
  ['Reed Bunting', 'Rietgors', 'Rohrammer', 'Bruant des roseaux'],
  ['Black Redstart', 'Zwarte roodstaart', 'Hausrotschwanz', 'Rougequeue noir'],
  ['Common Redstart', 'Gekraagde roodstaart', 'Gartenrotschwanz', 'Rougequeue à front blanc'],
  ['Eurasian Sparrowhawk', 'Sperwer', 'Sperber', 'Épervier d\'Europe'],
  ['Rose-ringed Parakeet', 'Halsbandparkiet', 'Halsbandsittich', 'Perruche à collier'],
  ['Egyptian Goose', 'Nijlgans', 'Nilgans', 'Ouette d\'Égypte'],
  ['Mallard', 'Wilde eend', 'Stockente', 'Canard colvert'],
  ['Common Pheasant', 'Fazant', 'Fasan', 'Faisan de Colchide'],
  ['Grey Heron', 'Blauwe reiger', 'Graureiher', 'Héron cendré'],
  ['Fly', 'Vlieg', 'Fliege', 'Mouche'],
];

const LANGUAGES = { nl: 1, de: 2, fr: 3 };
const SUPPORTED = ['en', ...Object.keys(LANGUAGES)];

// "Common Wood-Pigeon" and "common wood pigeon" are the same species name.
const normalize = name => String(name).toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
const ALIASES = { 'common wood pigeon': ['Wood Pigeon', 'Common Woodpigeon'], 'rock pigeon': ['Feral Pigeon', 'Rock Dove'] };

const INDEX = new Map();
for (const row of NAMES) {
  INDEX.set(normalize(row[0]), row);
  for (const alias of ALIASES[normalize(row[0])] || []) INDEX.set(normalize(alias), row);
}

// One species name in the wanted language ('en', 'nl', 'de', 'fr'); English when unknown.
function translate(name, language) {
  const column = LANGUAGES[language];
  const row = column && INDEX.get(normalize(name));
  return row ? row[column] : name;
}

// A list like "Great Tit, European Robin" (a visit can show several species).
function translateList(text, language) {
  return String(text || '').split(', ').map(name => translate(name, language)).join(', ');
}

module.exports = { translate, translateList, SUPPORTED, NAMES };
