// --- Configuration ---
const char* machine_id = "1313"; // Machine ID matching database (1313 ACE CNC SUPER JOBBER)

// --- Pin Definitions ---
const int PIN_PULSE = 4;   // GPIO 4 - Cycle Finish Relay NO Contact (Pulls to 3.3V when closed)
const int PIN_STATUS = 5;  // GPIO 5 - Green Stack Light Relay NO Contact (HIGH = Running, LOW = Stopped)
const int PIN_RUN_ENABLE = 12; // GPIO 12 - Output to CNC Interlock Relay Coil (HIGH = Enabled, LOW = Safe Cut)

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

// Character buffer for incoming serial command lines
char rxBuffer[128];
size_t rxIndex = 0;

void sendCurrentStatus() {
  int rawVal = digitalRead(PIN_STATUS);
  // Relay energized pulls pin HIGH -> Machine is Running
  const char* statusStr = (rawVal == HIGH) ? "Running" : "Stopped";
  
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
  } else if (strstr(line, "\"command\":\"stop\"") != NULL) {
    digitalWrite(PIN_RUN_ENABLE, LOW);
    Serial.println("{\"type\":\"log\",\"message\":\"CNC interlock relay de-energized (Run Locked)\"}");
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
  
  // Configure input pins with internal pull-down to prevent floating signals
  pinMode(PIN_PULSE, INPUT_PULLDOWN);
  pinMode(PIN_STATUS, INPUT_PULLDOWN);
  
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
