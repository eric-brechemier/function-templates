/*
  Simulring Funlet

  Description:
    Forward the call to up to 10 forwarding numbers in parallel,
    connecting the first one that picks up (stage 1). When that
    forwarding call ends, just hang up if it was successful,
    or redirect to the fallback URL/Funlet, if any (stage 2).

    This is an upgrade of the Simulring Twimlet [1].
    Designed to be backward-compatible with the Twimlet, it was
    extended to offer better support for internationalization.

  Contents:
    1. Configuration
    2. Input Parameters
    3. Output Helpers
    4. Main Handler
    5. Other Exports
    6. References
*/

/*
  1. Configuration

  Here you can change values for the input parameters,
  directly in the script.

  These values will be superseded by HTTP parameters and properties
  defined in the environment. You can customize the names and priorities
  of these various parameters in the next section: Input Parameters.
*/

let config = {
  // list of forwarding phone numbers
  phoneNumbers: [],

  // duration in seconds to let the call ring before the recipient picks up
  timeout: 20,

  // recording URL or text message to say,
  // e.g. asking the recipient to press a key to accept the call
  message: fromNumber =>
    `You are receiving a call from ${fromNumber}. Press any key to accept.`,

  // language code for conversion of text-to-speech messages,
  // e.g. 'en' or 'en-gb'
  language: "en",

  // voice for text-to-speech messages, one of 'man', 'woman' or 'alice'
  voice: "alice",

  // whether to request the recipient to press a key to accept the call
  humanCheck: false,

  // fallback URL where further instructions are requested
  // when the forwarding call fails
  fallbackUrl: ""
};

/*
  2. Input Parameters

  Each input parameter Foo is read by a separate function getFoo()
  which takes one parameter for each source:

    * params - object, the set of HTTP parameters
               from the URL (GET) or the body (POST) of the query
    * env - object, the set of environment properties
            defined in the Twilio account
    * config - object, the configuration object
               defined above in this script

  The HTTP parameters are considered first, then environment properties,
  then the script parameters. This can be customized in the functions below.
*/

function getPhoneNumbers(params, env, config) {
  let phoneNumbers = [];

  function addIfNotEmpty( phoneNumber ) {
    if ( typeof phoneNumber === "string" && phoneNumber !== "" ) {
      phoneNumbers.push( phoneNumber );
    }
  }

  if ( Array.isArray(params.PhoneNumbers) ) {
    params.PhoneNumbers.forEach(
      phoneNumber => addIfNotEmpty(phoneNumber)
    );
  } else {
    addIfNotEmpty( params.PhoneNumbers );
  }

  addIfNotEmpty( env.FUNLET_SIMULRING_PHONE_NUMBER1 );
  addIfNotEmpty( env.FUNLET_SIMULRING_PHONE_NUMBER2 );
  addIfNotEmpty( env.FUNLET_SIMULRING_PHONE_NUMBER3 );
  addIfNotEmpty( env.FUNLET_SIMULRING_PHONE_NUMBER4 );
  addIfNotEmpty( env.FUNLET_SIMULRING_PHONE_NUMBER5 );

  if ( Array.isArray(config.phoneNumbers) ) {
    config.phoneNumbers.forEach(
      phoneNumber => addIfNotEmpty(phoneNumber)
    );
  }

  return phoneNumbers;
}

function getTimeout(params, env, config) {
  let timeout = params.Timeout || env.FUNLET_SIMULRING_TIMEOUT;
  if ( typeof timeout === "string" && !isNaN(timeout) ) {
    return Number(timeout);
  }
  return config.timeout;
}

function isWhisper(params, env, config) {
  return ( typeof params.Whisper === "string" );
}

function getMessage(params, env, config) {
  const caller = params.From || params.Caller || "";
  return params.Message ||
    env.FUNLET_SIMULRING_MESSAGE ||
    ( typeof config.message === "function"?
        config.message( spell(caller) ):
        config.message
    );
}

function getLanguage(params, env, config) {
  return params.Language || env.FUNLET_SIMULRING_LANGUAGE || config.language;
}

function getVoice(params, env, config) {
  return params.Voice || env.FUNLET_SIMULRING_VOICE || config.voice;
}

function isHumanCheckRequired(params, env, config) {
  if ( typeof params.HumanCheck === "string" ) {
    return params.HumanCheck !== "false";
  }
  if ( typeof env.FUNLET_SIMULRING_HUMAN_CHECK === "string" ) {
    return env.FUNLET_SIMULRING_HUMAN_CHECK !== "false";
  }
  return config.humanCheck;
}

function getDigits(params, env, config) {
  if ( typeof params.Digits === "string" ) {
   return params.Digits;
  }
  return null;
}

function isDialDone(params, env, config) {
  return (typeof params.Dial === "string" );
}

// Copied from Forward Funlet
function getCallStatus(params, env, config) {
  const NO_CALL_STATUS = "";
  return params.DialStatus || params.DialCallStatus || NO_CALL_STATUS;
}

function getFallbackUrl(params, env, config) {
  return params.FailUrl ||
    env.FUNLET_SIMULRING_FALLBACK_URL ||
    config.fallbackUrl;
}

/*
  3. Output Helpers

  These helper functions build part of the output.

  This is where you can fine-tune the TwiML elements and attributes
  produced in response to each stage of the Funlet.
*/

// Copied from Whisper Funlet
function spell( numberString ) {
  const PAUSE = '. ';
  return numberString.split('').join(PAUSE)+PAUSE;
}

// Copied from Forward Funlet
function getForwardActionUrl( fallbackUrl ) {
  const BASE_URL = ".";
  let actionUrl = BASE_URL + "?Dial=true";
  if ( fallbackUrl !== "" ) {
    actionUrl += "&" + encodeURIComponent(fallbackUrl);
  }
  return actionUrl;
}

// Copied from Call Me Funlet
function getWhisperUrl( params ) {
  const
   BASE_WHISPER_URL=".?Whisper=true",
   SEP="&";

  let whisperUrl = BASE_WHISPER_URL;

  function copyStringParam( name ) {
    let value = params[name];
    if ( typeof value === "string" ) {
      whisperUrl += SEP + name + "=" + encodeURIComponent( value );
    }
  }

  copyStringParam( "Message" );
  copyStringParam( "Language" );
  copyStringParam( "Voice" );
  copyStringParam( "HumanCheck" );

  return whisperUrl;
}

/*
  Function: simulringStage1()

  Parameters:
    * response - Twilio.twiml.VoiceResponse, Twilio Voice response in progress
    * forwardingNumbers - string, the list of forwarding numbers
    * timeout - number, duration in seconds to let the forwarding call ring
                before the recipient picks up
    * whisperUrl - string, action URL to trigger the Whisper Funlet and get
                   instructions which ask the recipient to accept the call
    * fallbackUrl - string, URL of a script with further instructions
                    in case the forwarding call fails

  Response:
    The response is modified with instructions to:
      - forward the call to the first of the forwarding numbers
        to answer a simultaneous call, with given timeout,
      - to play a message asking the recipient to accept
        the call by pressing a key,
      - and to redirect to the given fallback URL
        if the forwarding call fails.
*/
function simulringStage1(
  response, forwardingNumbers, timeout, whisperUrl, fallbackUrl
) {
  let dial = response.dial({
    action: getForwardActionUrl( fallbackUrl ),
    timeout: timeout
  });
  forwardingNumbers.forEach(
    forwardingNumber => dial.number( {url:whisperUrl}, forwardingNumber )
  );
}

// Copied from Simple Message Funlet
function simpleMessage(response, message, language, voice) {
  if ( message.length === 0 ) {
    return;
  }
  if ( message.startsWith("http") ) {
    response.play({}, message);
  } else {
    response.say({language:language, voice:voice}, message);
  }
}

// Copied from Simple Menu Funlet
function gatherDigits(response, maxDigits, message, language, voice) {
  simpleMessage(
    response.gather({numDigits: maxDigits}),
    message,
    language,
    voice
  );
}

// Copied from Whisper Funlet
function whisperStage1(response, humanCheck, message, language, voice) {
  gatherDigits(response, 1, message, language, voice);
  if ( humanCheck ) {
    response.hangup();
  }
}
let simulringStage2 = whisperStage1;

// Copied from Whisper Funlet
function whisperStage2(response, digits) {
  if ( digits === null ) {
    return false;
  }
  if ( digits==="" ) {
    response.hangup();
  }
  return true;
}
let simulringStage3 = whisperStage2;

// Copied from Forward Funlet
function forwardStage2(response, isDialDone, callStatus, fallbackUrl) {
  if (isDialDone) {
    if (
      callStatus !== "answered" &&
      callStatus !== "completed" &&
      fallbackUrl !== ""
    ) {
      response.redirect( fallbackUrl );
    } else {
      response.hangup();
    }
  }
  return isDialDone;
}
let simulringStage4 = forwardStage2;

/*
  4. Main Handler

  This is the entry point to your Twilio Function,
  which will run to process an incoming HTTP request
  such as the ones generated by Twilio events.
*/

exports.handler = function(env, params, reply) {
  const NO_ERROR = null;

  let
    response = new Twilio.twiml.VoiceResponse(),
    isDial = isDialDone(params, env, config),
    callStatus = getCallStatus(params, env, config),
    fallbackUrl = getFallbackUrl(params, env, config),
    digits = getDigits(params, env, config),
    humanCheckRequired = isHumanCheckRequired(params, env, config),
    message = getMessage(params, env, config),
    language = getLanguage(params, env, config),
    voice = getVoice(params, env, config),
    forwardingNumbers = getPhoneNumbers(params, env, config),
    timeout = getTimeout(params, env, config),
    whisperUrl = getWhisperUrl(params);

  simulringStage4(response, isDial, callStatus, fallbackUrl) ||
  simulringStage3(response, digits) ||
  (isWhisper(params, env, config)?
    simulringStage2(response, humanCheckRequired, message, language, voice):
    simulringStage1(
      response, forwardingNumbers, timeout, whisperUrl, fallbackUrl
    )
  );

  reply(NO_ERROR, response);
};

/*
  5. Other Exports

  These internal features are exported too, for the purpose of unit tests.
*/

exports.config = config;

exports.input = {
  getPhoneNumbers: getPhoneNumbers,
  getTimeout: getTimeout,
  isWhisper: isWhisper,
  getMessage: getMessage,
  getLanguage: getLanguage,
  getVoice: getVoice,
  isHumanCheckRequired: isHumanCheckRequired,
  getDigits: getDigits,
  isDialDone: isDialDone,
  getCallStatus: getCallStatus,
  getFallbackUrl: getFallbackUrl
};

exports.output = {
  spell: spell,
  getForwardActionUrl: getForwardActionUrl,
  getWhisperUrl: getWhisperUrl,
  simpleMessage: simpleMessage,
  gatherDigits: gatherDigits,
  simulringStage1: simulringStage1,
  simulringStage2: simulringStage2,
  simulringStage3: simulringStage3,
  simulringStage4: simulringStage4
};

/*
  6. References

    [1] Simulring Twimlet
    https://www.twilio.com/labs/twimlets/simulring

    [2] Simulring Funlet
    https://github.com/twilio-labs/function-templates
                                  /tree/master/funlet-simulring

    [3] Simulring Funlet: Discussion
    https://github.com/twilio-labs/function-templates/issues/13
*/
