#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h> // Ensure you install "ArduinoJson" by Benoit Blanchon in Library Manager
#include "credentials.h"

// --- Configuration ---
const char* ssid = WIFI_SSID;
const char* password = WIFI_PASSWORD;
const char* mqtt_server = MQTT_SERVER;
const int mqtt_port = MQTT_PORT;

const char* machine_id = "1313"; // Machine ID matching database (1313 ACE CNC SUPER JOBBER)
const char* topic_pulse = "cnc/1313/pulse";
const char* topic_status = "cnc/1313/status";

// --- Pin Definitions ---
const int PIN_PULSE = 4;   // GPIO 4 - Cycle Finish Relay NO Contact (Pulls to 3.3V when closed)
const int PIN_STATUS = 5;  // GPIO 5 - Green Stack Light Relay NO Contact (HIGH = Running, LOW = Stopped)

// --- Debounce & Timing Variables ---
unsigned long lastPulseDebounce = 0;
const unsigned long PARTS_LOCKOUT_DELAY = 1500; // 1.5 seconds minimum between finished parts (lockout)
unsigned long lastCycleStart = 0;

// Debounce for mechanical relay noise on PIN_PULSE
int lastPulsePinState = LOW;
int stablePulseState = LOW;
unsigned long lastPulsePinChange = 0;
const unsigned long RELAY_DEBOUNCE_DELAY = 50; // 50ms contact debounce time

int lastStatusState = -1; // -1 = uninitialized
unsigned long lastStatusCheck = 0;
const unsigned long STATUS_CHECK_INTERVAL = 500; // Poll status state every 500ms

WiFiClient espClient;
PubSubClient client(espClient);

void setupWiFi() {
  delay(10);
  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("");
  Serial.println("Wi-Fi connected.");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
}

void reconnectMQTT() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection...");
    // Create a unique client ID based on ESP32 MAC address
    String clientId = "ESP32Client-" + String(WiFi.macAddress());
    
    // Connect to Broker. We configure a "Last Will and Testament" (LWT) so that
    // if the ESP32 loses power or Wi-Fi, the broker automatically marks the machine "No Signal"
    StaticJsonDocument<64> lwtPayload;
    lwtPayload["status"] = "No Signal";
    String lwtString;
    serializeJson(lwtPayload, lwtString);

    if (client.connect(clientId.c_str(), topic_status, 0, true, lwtString.c_str())) {
      Serial.println("connected!");
      // Send initial status after connection
      sendCurrentStatus();
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

void sendCurrentStatus() {
  int rawVal = digitalRead(PIN_STATUS);
  // Relay energized pulls pin HIGH -> Machine is Running
  String statusStr = (rawVal == HIGH) ? "Running" : "Stopped";
  
  StaticJsonDocument<64> doc;
  doc["status"] = statusStr;
  
  char buffer[128];
  serializeJson(doc, buffer);
  client.publish(topic_status, buffer, true); // Retained message
  Serial.print("Published status: ");
  Serial.println(statusStr);
}

void setup() {
  Serial.begin(115200);
  
  // Configure input pins with internal pull-down to prevent floating signals
  pinMode(PIN_PULSE, INPUT_PULLDOWN);
  pinMode(PIN_STATUS, INPUT_PULLDOWN);

  setupWiFi();
  client.setServer(mqtt_server, mqtt_port);
  
  lastCycleStart = millis();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    setupWiFi();
  }
  
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();

  // --- 1. Read Cycle Complete Pulse with debounce ---
  int currentPulsePinVal = digitalRead(PIN_PULSE);
  
  // If the pin state changed (noise or transition)
  if (currentPulsePinVal != lastPulsePinState) {
    lastPulsePinChange = millis();
    lastPulsePinState = currentPulsePinVal;
  }

  // If the state is stable for more than RELAY_DEBOUNCE_DELAY
  if ((millis() - lastPulsePinChange) > RELAY_DEBOUNCE_DELAY) {
    // If we transition to HIGH (active closure)
    if (currentPulsePinVal == HIGH && stablePulseState == LOW) {
      stablePulseState = HIGH;
      
      unsigned long now = millis();
      // Check lockout delay to prevent double count from slow/multiple cycles
      if ((now - lastPulseDebounce) > PARTS_LOCKOUT_DELAY) {
        float cycleTime = (now - lastCycleStart) / 1000.0;
        
        // Safety cap to avoid astronomical numbers if machine was off
        if (cycleTime > 3600.0) {
          cycleTime = 15.0; // Fallback to ideal if idle for > 1 hour
        }
        
        // Prepare JSON payload
        StaticJsonDocument<128> doc;
        doc["cycleTime"] = cycleTime;
        doc["isGood"] = true; // Default to true. Operator can log scraps in the UI if needed
        
        char buffer[128];
        serializeJson(doc, buffer);
        client.publish(topic_pulse, buffer);
        
        Serial.print("Part complete (Machine 1313)! Cycle Time: ");
        Serial.print(cycleTime);
        Serial.println("s");

        lastCycleStart = now;
        lastPulseDebounce = now;
      }
    } else if (currentPulsePinVal == LOW && stablePulseState == HIGH) {
      // Transition back to LOW
      stablePulseState = LOW;
    }
  }

  // --- 2. Read Running/Stopped Status changes ---
  if (millis() - lastStatusCheck > STATUS_CHECK_INTERVAL) {
    int currentVal = digitalRead(PIN_STATUS);
    if (currentVal != lastStatusState) {
      lastStatusState = currentVal;
      sendCurrentStatus();
    }
    lastStatusCheck = millis();
  }
}
