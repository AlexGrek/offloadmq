import requests
import json
import time

# Ollama API details
OLLAMA_API_URL = "http://localhost:11434/api/chat"
REQUEST_PAYLOAD = {
    "model": "mistral",
    "messages": [
        {"role": "user", "content": "What is the capital of France? Describe it with some sentences without a name!"}
    ],
    "stream": True
}

def stream_and_print_response(api_url, payload, interval=2):
    """
    Streams response from an API, buffers it, and prints the content every 'interval' seconds.
    """
    buffer = ""
    last_print_time = time.time()

    try:
        # Use a `with` statement to ensure the connection is closed
        with requests.post(api_url, json=payload, stream=True) as response:
            response.raise_for_status()  # Raise an exception for bad status codes

            # Iterate over the streamed content line by line
            for line in response.iter_lines(decode_unicode=True):
                # The response is newline-delimited JSON
                if line.strip():
                    try:
                        data = json.loads(line)
                        if "message" in data and "content" in data["message"]:
                            # Add the new content to our buffer
                            buffer += data["message"]["content"]
                            
                        current_time = time.time()
                        # Check if 2 seconds have passed since the last print
                        if current_time - last_print_time >= interval:
                            print(buffer)
                            buffer = ""  # Clear the buffer
                            last_print_time = current_time
                        
                        # Stop if the stream is done
                        if data.get("done"):
                            if buffer:
                                print(buffer) # Print any remaining content
                            print("\n--- End of Stream ---")
                            return

                    except json.JSONDecodeError as e:
                        print(f"Error decoding JSON: {e}")
                        continue
    except requests.exceptions.RequestException as e:
        print(f"Request failed: {e}")

if __name__ == "__main__":
    print("Starting streaming client...")
    stream_and_print_response(OLLAMA_API_URL, REQUEST_PAYLOAD)
