import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST")return json({error:"Metodo non consentito."},405);
  const apiKey=Deno.env.get("OPENAI_API_KEY");
  if(!apiKey)return json({error:"Il motore AI non è ancora configurato sul server."},503);
  try{
    const {image,price,store,cellar=[]}=await req.json();
    if(typeof image!=="string"||!image.startsWith("data:image/")||image.length>7_000_000)return json({error:"Foto mancante o troppo grande."},400);
    const cellarText=JSON.stringify(cellar).slice(0,30_000);
    const prompt=`Analizza la bottiglia di vino fotografata per un collezionista italiano. Prezzo proposto: ${price??"non indicato"} EUR. Venditore: ${store||"non indicato"}. Confronta con questa cantina: ${cellarText}. Non inventare dati non leggibili: segnala l'incertezza. Restituisci solo JSON valido conforme allo schema.`;
    const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({model:"gpt-5.6",input:[{role:"user",content:[{type:"input_text",text:prompt},{type:"input_image",image_url:image,detail:"high"}]}],text:{format:{type:"json_schema",name:"wine_analysis",strict:true,schema:{type:"object",additionalProperties:false,properties:{wine_name:{type:"string"},producer:{type:"string"},vintage:{type:["integer","null"]},region:{type:["string","null"]},verdict:{type:"string"},score:{type:"integer",minimum:0,maximum:100},summary:{type:"string"},market_price:{type:["string","null"]},strengths:{type:"array",items:{type:"string"}},cautions:{type:"array",items:{type:"string"}},buy_advice:{type:"string"},in_cellar_match:{anyOf:[{type:"null"},{type:"object",additionalProperties:false,properties:{name:{type:"string"},quantity:{type:"integer"}},required:["name","quantity"]}]}},required:["wine_name","producer","vintage","region","verdict","score","summary","market_price","strengths","cautions","buy_advice","in_cellar_match"]}}}})});
    const payload=await response.json();
    if(!response.ok)return json({error:"Il servizio di analisi non è disponibile in questo momento."},502);
    const output=payload.output?.flatMap((item:{content?:Array<{type:string,text?:string}>})=>item.content||[]).find((part:{type:string})=>part.type==="output_text")?.text;
    if(!output)return json({error:"Non sono riuscito a leggere la risposta del Sommelier."},502);
    return json(JSON.parse(output));
  }catch(error){console.error(error);return json({error:"Non sono riuscito ad analizzare questa foto."},500)}
});
