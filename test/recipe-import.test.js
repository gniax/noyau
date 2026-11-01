import test from "node:test";
import assert from "node:assert/strict";
import { importRecipe, robotsAllows, extractRecipe } from "../server/recipe-import.js";
const html = `<script type="application/ld+json">{"@graph":[{"@type":"Recipe","name":"Plat maison","recipeIngredient":["200 g de riz","3 tomates"],"totalTime":"PT1H5M","recipeYield":"3 portions","recipeInstructions":[{"@type":"HowToStep","text":"Cuire le riz"},{"@type":"HowToSection","itemListElement":[{"text":"Ajouter les tomates"}]}]}]}</script>`;
test("Recipe JSON-LD extraction preserves source and requires manual ingredient mapping", () => {
 const data = extractRecipe(html, "https://www.750g.com/plat.htm"); assert.equal(data.title, "Plat maison"); assert.equal(data.minutes, 65); assert.equal(data.servings, 3); assert.deepEqual(data.rawIngredients, ["200 g de riz", "3 tomates"]); assert.deepEqual(data.steps, ["Cuire le riz", "Ajouter les tomates"]); assert.equal(data.sourceUrl, "https://www.750g.com/plat.htm");
});
test("robots denies protected routes and honors longest allowed rule and end marker", () => {
 const robots = "User-agent: *\nDisallow: /private/*\nAllow: /private/public\nDisallow: /exact$\n"; assert.equal(robotsAllows(robots, "/private/a"), false); assert.equal(robotsAllows(robots, "/private/public/x"), true); assert.equal(robotsAllows(robots, "/exact"), false); assert.equal(robotsAllows(robots, "/exactly"), true);
});
test("import checks robots and rejects private addresses and unsafe redirects", async () => {
 let calls = 0; const fetchImpl = async (url) => { calls++; if (new URL(url).pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /interdit\n"); return new Response(html); };
 assert.equal((await importRecipe("https://www.750g.com/plat.htm", { fetchImpl, llm: async () => null })).title, "Plat maison"); assert.equal(calls, 2);
 await assert.rejects(importRecipe("https://www.750g.com/interdit", { fetchImpl, llm: async () => null }), /interdit/); await assert.rejects(importRecipe("https://127.0.0.1:4242/", { fetchImpl }), /requis/);
 await assert.rejects(importRecipe("https://www.750g.com/plat.htm", { fetchImpl: async (url) => new URL(url).pathname === "/robots.txt" ? new Response("User-agent: *\nAllow: /") : Response.redirect("https://127.0.0.1/", 302) }), /requis/);
});

test('public URLs use extracted recipe and mapped ingredients', async () => {
 const fetchImpl = async url => new URL(url).pathname === '/robots.txt' ? new Response('User-agent: *\nAllow: /') : new Response(html);
 const result = await importRecipe('https://example.com/recipe', {fetchImpl, llm: async () => ({ingredients:[{ingredientId:'rice',quantity:200}]})});
 assert.equal(result.title,'Plat maison'); assert.deepEqual(result.ingredients,[{ingredientId:'rice',quantity:200}]);
});
test('private and reserved targets remain blocked', async () => {
 const {publicIPv4, publicTarget} = await import('../server/public-url-fetch.js');
 for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','10.0.0.1','100.64.0.1']) assert.equal(publicIPv4(ip),false);
 assert.equal(publicIPv4('8.8.8.8'),true);
 assert.throws(()=>publicTarget('https://localhost/'),/public/);
 assert.throws(()=>publicTarget('https://127.0.0.1/'),/public/);
});

test('imports bounded source image and keeps mapped ingredients editable', async () => {
 const image = Buffer.from([0xff,0xd8,0xff,0xdb,0,1]);
 const fetchImpl = async url => { const u = new URL(url); if(u.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /'); if(u.pathname === '/photo.jpg') return new Response(image); return new Response(`<meta property="og:image" content="https://example.com/photo.jpg">${html}`); };
 const data = await importRecipe('https://example.com/recipe',{fetchImpl,llm:async()=>({ingredients:[{ingredientId:'rice',quantity:200}]})});
 assert.match(data.imageData,/^data:image\/jpeg;base64,/); assert.equal(data.ingredients[0].quantity,200);
});
test('proxy output rejects unknown ingredients and absurd quantities', async () => {
 const {recipeLlm}=await import('../server/recipe-import.js');
 const fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'Riz',rawIngredients:['200 g de riz'],steps:['Cuire le riz'],ingredients:[{ingredientId:'rice',quantity:200},{ingredientId:'invalid',quantity:1},{ingredientId:'oil',quantity:-4}]})}}]}));
 const data=await recipeLlm('Recette suffisamment longue pour être analysée.',{fetchImpl});
 assert.deepEqual(data.ingredients,[{ingredientId:'rice',quantity:200}]);
});

test('video import uses description and captions to prefill editable recipe', async () => {
 const data = await importRecipe('https://www.youtube.com/watch?v=123', {
   videoReader: async () => ({title:'Poulet',description:'Poulet et riz',transcript:'Faire cuire le poulet puis le riz',thumbnail:''}),
   llm: async (source) => { assert.match(source,/Faire cuire/); return {title:'Poulet et riz',rawIngredients:['200 g riz'],ingredients:[{ingredientId:'rice',quantity:200}],steps:['Cuire le riz']}; },
 });
 assert.equal(data.title,'Poulet et riz'); assert.equal(data.ingredients[0].quantity,200); assert.deepEqual(data.steps,['Cuire le riz']);
});
test('video captions are bounded and subprocess is restricted to supported platforms', async () => {
 const {readRecipeVideo,isRecipeVideo} = await import('../server/recipe-video.js');
 assert.equal(isRecipeVideo('https://www.youtube.com/watch?v=123'),true); assert.equal(isRecipeVideo('https://www.tiktok.com/@test/video/123'),true); assert.equal(isRecipeVideo('https://youtube.com.evil.example/'),false);
 let args; const run = async (_bin, argv) => {args=argv; return {stdout:JSON.stringify({title:'Recette',description:'Description',subtitles:{fr:[{ext:'vtt',url:'https://captions.example/sub'}]}})};};
 const fetchImpl=async()=>new Response('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nCuire le poulet\n');
 const data=await readRecipeVideo('https://www.youtube.com/watch?v=123',{run,fetchImpl});
 assert.equal(data.transcript,'Cuire le poulet'); assert.ok(args.includes('--ignore-config')); assert.ok(args.includes('--skip-download'));
 await assert.rejects(readRecipeVideo('https://example.com/',{run,fetchImpl}),/non prise en charge/);
});

test('Instagram public links use video recipe extraction without exposing private hosts', async () => {
 const {isRecipeVideo} = await import('../server/recipe-video.js');
 assert.equal(isRecipeVideo('https://www.instagram.com/reel/ABC123/'),true);
 assert.equal(isRecipeVideo('https://instagram.com.evil.example/reel/ABC123/'),false);
 let read = false; const recipe = {title:'Gâteau', rawIngredients:['200 g farine'], ingredients:[{ingredientId:'flour',quantity:200}], steps:['Mélanger la farine']};
 const result = await importRecipe('https://www.instagram.com/reel/ABC123/',{videoReader:async()=>{read=true;return {title:'Gâteau',description:'200 g farine',transcript:'Mélanger la farine'};},llm:async()=>recipe});
 assert.equal(read,true); assert.equal(result.title,'Gâteau'); assert.equal(result.ingredients[0].ingredientId,'flour');
});

test('extracts publicly embedded social carousel description, not configuration text', async () => {
 const {extractSocialDescription} = await import('../server/recipe-import.js');
 const payload = {config:{description:'Not a recipe'},post:{id:'123',author:{name:'chef'},imagePost:{images:[]},desc:'200 g de riz puis cuire 20 minutes'}};
 assert.equal(extractSocialDescription(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script>`),'200 g de riz puis cuire 20 minutes');
});

test('explicit Instagram link reads public metadata and reports inferred steps and quantities', async () => {
 const meta='<meta name="description" content="Cream stew: chicken, carrot, milk">';
 const fetchImpl=async()=>new Response(meta);
 const result=await importRecipe('https://www.instagram.com/reel/abc/',{
  videoReader:async()=>{throw Error('no video metadata');}, fetchImpl,
  llm:async(source)=>{assert.match(source,/Cream stew/);return {title:'Cream stew',rawIngredients:['chicken','carrot','milk'],ingredients:[{ingredientId:'chicken',quantity:250}],steps:['Cook chicken'],inferredSteps:true,inferredQuantities:true};}
 });
 assert.equal(result.inferredSteps,true);assert.equal(result.inferredQuantities,true);assert.equal(result.ingredients[0].ingredientId,'chicken');
});
test('social post redirects cannot send the importer to private networks', async () => {
 let requests=0; const fetchImpl=async()=>{requests++;return new Response('',{status:302,headers:{location:'https://127.0.0.1/'}});};
 await assert.rejects(importRecipe('https://www.instagram.com/reel/abc/',{videoReader:async()=>{throw Error('no metadata');},fetchImpl,llm:async()=>null}),/requis|publique|règles/i);
 assert.ok(requests<=2);
});
