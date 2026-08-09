// --- Configuration ---
const char* machine_id = "1313"; // Machine ID matching database (1313 ACE CNC SUPER JOBBER)

// --- Pin Definitions ---
const int PIN_PULSE = 4;   // GPIO 4 - Cycle Finish Relay NO Contact (Pulls to 3.3V when closed)
const int PIN_RUN_ENABLE = 27; // GPIO 27 - Output to CNC Interlock Relay Coil (Safer than GPIO 12 bootstrapping pin)

// --- Debounce & Timing Variables ---
unsigned long lastPulseDebounce = 0;
const unsigned long PARTS_LOCKOUT_DELAY = 1500; // 1.5 seconds minimum between finished parts (lockout)
unsigned long lastCycleStart = 0;

// --- Connectivity Heartbeat ---
// Sent independently of Cycle Complete pulses - a machine can legitimately go several minutes
// between pulses (measuring, tool change, program hold, long cycle, load/unload) while staying
// fully connected the whole time. The heartbeat is the ONLY signal the backend's watchdog uses
// to judge ESP32<->Pi connectivity (see watchdogService.js) - keeping it on its own fast, fixed
// interval, unrelated to what the machine is actually doing, is what makes that possible.
unsigned long lastHeartbeatSent = 0;
const unsigned long HEARTBEAT_INTERVAL = 5000; // 5 seconds

// Debounce for mechanical relay noise on PIN_PULSE
int lastPulsePinState = LOW;
int stablePulseState = LOW;
unsigned long lastPulsePinChange = 0;
const unsigned long RELAY_DEBOUNCE_DELAY = 50; // 50ms contact debounce time

// Character buffer for incoming serial command lines
char rxBuffer[128];
size_t rxIndex = 0;

void sendCurrentStatus() {
  int runEnableVal = digitalRead(PIN_RUN_ENABLE);
  // Status is authoritative from the interlock relay we ourselves drive - no separate
  // physical "is it actually running" sensing.
  const char* statusStr = (runEnableVal == HIGH) ? "Running" : "Stopped";

  // Output JSON formatted telemetry over Serial
  Serial.print("{\"type\":\"status\",\"status\":\"");
  Serial.print(statusStr);
  Serial.println("\"}");
}

/**
 * Parses received C-string commands using safe static comparisons
 */
void parseCommand(const char* line) {
  if (strstr(line, "\"command\":\"resume\"") != NULL) {
    digitalWrite(PIN_RUN_ENABLE, HIGH);
    Serial.println("{\"type\":\"log\",\"message\":\"CNC interlock relay energized (Run Enabled)\"}");

    // Reset cycle start timer on resume so that the next pulse calculates cycle duration correctly
    lastCycleStart = millis();

    sendCurrentStatus();

    // Emit command acknowledgement
    Serial.println("{\"type\":\"ack\",\"command\":\"resume\",\"status\":\"success\"}");
  } else if (strstr(line, "\"command\":\"stop\"") != NULL) {
    digitalWrite(PIN_RUN_ENABLE, LOW);
    Serial.println("{\"type\":\"log\",\"message\":\"CNC interlock relay de-energized (Run Locked)\"}");

    sendCurrentStatus();

    // Emit command acknowledgement
    Serial.println("{\"type\":\"ack\",\"command\":\"stop\",\"status\":\"success\"}");
  }
}

/**
 * Reads bytes from Serial asynchronously to avoid blocking the main execution loop
 */
void readSerialCommands() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    
    if (c == '\n' || c == '\r') {
      if (rxIndex > 0) {
        rxBuffer[rxIndex] = '\0'; // Null terminate
        parseCommand(rxBuffer);
        rxIndex = 0; // Reset
      }
    } else {
      if (rxIndex < sizeof(rxBuffer) - 1) {
        rxBuffer[rxIndex++] = c;
      } else {
        // Buffer overflow protection: reset index to discard corrupted input
        rxIndex = 0;
      }
    }
  }
}

void setup() {
  // Initialize Serial port for USB communication at 115200 baud
  Serial.begin(115200);
  
  // Configure input pin with internal pull-down to prevent floating signal
  pinMode(PIN_PULSE, INPUT_PULLDOWN);

  // Configure run-enable output pin, starting in LOW (disabled) state for safety
  pinMode(PIN_RUN_ENABLE, OUTPUT);
  digitalWrite(PIN_RUN_ENABLE, LOW);
  
  lastCycleStart = millis();
  
  // Wait a moment for Serial to initialize and send initial status
  delay(500);
  sendCurrentStatus();
}

void loop() {
  // Listen for control commands from the Edge Gateway backend
  readSerialCommands();

  // --- 0. Connectivity heartbeat (independent of production) ---
  if ((millis() - lastHeartbeatSent) >= HEARTBEAT_INTERVAL) {
    lastHeartbeatSent = millis();
    Serial.println("{\"type\":\"heartbeat\"}");
  }

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
        
        // Output JSON formatted telemetry over Serial
        Serial.print("{\"type\":\"pulse\",\"cycleTime\":");
        Serial.print(cycleTime, 2);
        Serial.println("}");

        lastCycleStart = now;
        lastPulseDebounce = now;
      }
    } else if (currentPulsePinVal == LOW && stablePulseState == HIGH) {
      // Transition back to LOW
      stablePulseState = LOW;
    }
  }
}
