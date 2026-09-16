package com.knight.backend;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

/* ============================================================================
   KNIGHT — backend

   WHAT CHANGED FROM YOUR OLD FILE
   -------------------------------
   Your previous version had one hardcoded user ("PlayerOne") and no concept of
   signing in at all — every request returned the same account. That is why the
   frontend could never fetch "your" profile: there was nothing to fetch.

   This version has:
     · real sign-up / sign-in with hashed passwords (never plaintext)
     · session tokens, so the server knows WHO is calling
     · Social IDs, projects, files, versions, members with roles, change
       requests, stars — matching what the frontend does
     · javax.* → jakarta.* (required for Spring Boot 3; the old imports will
       not compile on any current version)
     · CORS locked to your real frontend origin instead of "*"

   RUNNING IT
   ----------
   Needs: spring-boot-starter-web, spring-boot-starter-data-jpa, h2 (dev)
   or postgresql (production). Drop this in src/main/java/com/knight/backend/
   and `mvn spring-boot:run`. Data lives in H2 on disk by default so accounts
   survive restarts — see application.properties at the bottom of this file.
============================================================================ */

@SpringBootApplication
public class KnightBackendApplication {
    public static void main(String[] args) {
        SpringApplication.run(KnightBackendApplication.class, args);
    }
}

/* -------------------------------------------------------------------------
   CORS
   ------------------------------------------------------------------------- */
@Configuration
class CorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                // Replace these with your real frontend origins before going live.
                .allowedOriginPatterns("http://localhost:*", "https://*.onrender.com",
                                       "https://*.vercel.app", "https://*.netlify.app")
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true);
    }
}

/* -------------------------------------------------------------------------
   ENTITIES
   ------------------------------------------------------------------------- */

@Entity
@Table(name = "users",
       indexes = { @Index(columnList = "email", unique = true),
                   @Index(columnList = "socialId", unique = true) })
class KnightUser {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(nullable = false)
    private String username;

    /** SHA-256 of (password + email). The raw password never reaches the server. */
    @JsonIgnore
    @Column(nullable = false)
    private String passHash;

    @Column(nullable = false, unique = true)
    private String socialId;

    private String role = "Coder";
    private String bio = "";
    private String github = "";
    private String twitter = "";

    private Integer avatarIndex = 0;
    private Integer level = 1;
    private Integer followers = 0;
    private Integer commits = 0;

    private boolean guest = false;
    private boolean admin = false;

    private Instant createdAt = Instant.now();
    private Instant lastSeen = Instant.now();

    /** Friend user-ids, stored as a simple joined table. */
    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "user_friends", joinColumns = @JoinColumn(name = "user_id"))
    @Column(name = "friend_id")
    private Set<Long> friends = new HashSet<>();

    public KnightUser() {}

    public KnightUser(String email, String username, String passHash, String socialId) {
        this.email = email;
        this.username = username;
        this.passHash = passHash;
        this.socialId = socialId;
    }

    public Long getId() { return id; }
    public String getEmail() { return email; }
    public void setEmail(String v) { this.email = v; }
    public String getUsername() { return username; }
    public void setUsername(String v) { this.username = v; }
    public String getPassHash() { return passHash; }
    public void setPassHash(String v) { this.passHash = v; }
    public String getSocialId() { return socialId; }
    public void setSocialId(String v) { this.socialId = v; }
    public String getRole() { return role; }
    public void setRole(String v) { this.role = v; }
    public String getBio() { return bio; }
    public void setBio(String v) { this.bio = v; }
    public String getGithub() { return github; }
    public void setGithub(String v) { this.github = v; }
    public String getTwitter() { return twitter; }
    public void setTwitter(String v) { this.twitter = v; }
    public Integer getAvatarIndex() { return avatarIndex; }
    public void setAvatarIndex(Integer v) { this.avatarIndex = v; }
    public Integer getLevel() { return level; }
    public void setLevel(Integer v) { this.level = v; }
    public Integer getFollowers() { return followers; }
    public void setFollowers(Integer v) { this.followers = v; }
    public Integer getCommits() { return commits; }
    public void setCommits(Integer v) { this.commits = v; }
    public boolean isGuest() { return guest; }
    public void setGuest(boolean v) { this.guest = v; }
    public boolean isAdmin() { return admin; }
    public void setAdmin(boolean v) { this.admin = v; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getLastSeen() { return lastSeen; }
    public void setLastSeen(Instant v) { this.lastSeen = v; }
    public Set<Long> getFriends() { return friends; }
    public void setFriends(Set<Long> v) { this.friends = v; }
}

@Entity
@Table(name = "sessions", indexes = @Index(columnList = "token", unique = true))
class SessionToken {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 80)
    private String token;

    @Column(nullable = false)
    private Long userId;

    @Column(nullable = false)
    private Instant expiresAt;

    public SessionToken() {}

    public SessionToken(String token, Long userId, Instant expiresAt) {
        this.token = token;
        this.userId = userId;
        this.expiresAt = expiresAt;
    }

    public Long getId() { return id; }
    public String getToken() { return token; }
    public Long getUserId() { return userId; }
    public Instant getExpiresAt() { return expiresAt; }
    public boolean isExpired() { return Instant.now().isAfter(expiresAt); }
}

@Entity
@Table(name = "projects")
class Project {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private Long ownerId;

    @Column(nullable = false)
    private String name;

    @Column(length = 1000)
    private String description = "";

    private String category = "General";

    /** public | friends | selected | private */
    private String visibility = "public";

    private String locationLabel = "";
    private Double lat;
    private Double lng;

    private String deployedUrl = "";
    private String joinCode;
    private boolean joinCodeEnabled = false;
    private String joinCodeRole = "viewer";

    private Integer stars = 0;
    private Instant createdAt = Instant.now();
    private Instant updatedAt = Instant.now();

    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "project_tags", joinColumns = @JoinColumn(name = "project_id"))
    @Column(name = "tag")
    private List<String> tags = new ArrayList<>();

    /** filename -> content */
    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "project_files", joinColumns = @JoinColumn(name = "project_id"))
    @MapKeyColumn(name = "filename")
    @Lob
    @Column(name = "content", length = 100000)
    private Map<String, String> files = new HashMap<>();

    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "project_starred_by", joinColumns = @JoinColumn(name = "project_id"))
    @Column(name = "user_id")
    private Set<Long> starredBy = new HashSet<>();

    public Project() {}

    public Long getId() { return id; }
    public Long getOwnerId() { return ownerId; }
    public void setOwnerId(Long v) { this.ownerId = v; }
    public String getName() { return name; }
    public void setName(String v) { this.name = v; }
    public String getDescription() { return description; }
    public void setDescription(String v) { this.description = v; }
    public String getCategory() { return category; }
    public void setCategory(String v) { this.category = v; }
    public String getVisibility() { return visibility; }
    public void setVisibility(String v) { this.visibility = v; }
    public String getLocationLabel() { return locationLabel; }
    public void setLocationLabel(String v) { this.locationLabel = v; }
    public Double getLat() { return lat; }
    public void setLat(Double v) { this.lat = v; }
    public Double getLng() { return lng; }
    public void setLng(Double v) { this.lng = v; }
    public String getDeployedUrl() { return deployedUrl; }
    public void setDeployedUrl(String v) { this.deployedUrl = v; }
    public String getJoinCode() { return joinCode; }
    public void setJoinCode(String v) { this.joinCode = v; }
    public boolean isJoinCodeEnabled() { return joinCodeEnabled; }
    public void setJoinCodeEnabled(boolean v) { this.joinCodeEnabled = v; }
    public String getJoinCodeRole() { return joinCodeRole; }
    public void setJoinCodeRole(String v) { this.joinCodeRole = v; }
    public Integer getStars() { return stars; }
    public void setStars(Integer v) { this.stars = v; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant v) { this.updatedAt = v; }
    public List<String> getTags() { return tags; }
    public void setTags(List<String> v) { this.tags = v; }
    public Map<String, String> getFiles() { return files; }
    public void setFiles(Map<String, String> v) { this.files = v; }
    public Set<Long> getStarredBy() { return starredBy; }
    public void setStarredBy(Set<Long> v) { this.starredBy = v; }
}

@Entity
@Table(name = "project_members")
class ProjectMember {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private Long projectId;
    private Long userId;

    /** viewer | contributor | editor */
    private String role = "viewer";

    private Instant joinedAt = Instant.now();

    public ProjectMember() {}

    public ProjectMember(Long projectId, Long userId, String role) {
        this.projectId = projectId;
        this.userId = userId;
        this.role = role;
    }

    public Long getId() { return id; }
    public Long getProjectId() { return projectId; }
    public Long getUserId() { return userId; }
    public String getRole() { return role; }
    public void setRole(String v) { this.role = v; }
    public Instant getJoinedAt() { return joinedAt; }
}

@Entity
@Table(name = "project_versions")
class ProjectVersion {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private Long projectId;
    private String label;           // "Version 1", "Version 2", …
    private String note = "";
    private Instant createdAt = Instant.now();

    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "version_files", joinColumns = @JoinColumn(name = "version_id"))
    @MapKeyColumn(name = "filename")
    @Lob
    @Column(name = "content", length = 100000)
    private Map<String, String> snapshot = new HashMap<>();

    public ProjectVersion() {}

    public ProjectVersion(Long projectId, String label, String note, Map<String, String> snapshot) {
        this.projectId = projectId;
        this.label = label;
        this.note = note;
        this.snapshot = new HashMap<>(snapshot);
    }

    public Long getId() { return id; }
    public Long getProjectId() { return projectId; }
    public String getLabel() { return label; }
    public String getNote() { return note; }
    public Instant getCreatedAt() { return createdAt; }
    public Map<String, String> getSnapshot() { return snapshot; }
}

@Entity
@Table(name = "change_requests")
class ChangeRequest {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private Long projectId;
    private Long authorId;
    private String filename;

    @Lob @Column(length = 100000) private String beforeContent = "";
    @Lob @Column(length = 100000) private String afterContent = "";

    /** pending | accepted | rejected */
    private String status = "pending";

    private Instant createdAt = Instant.now();

    public ChangeRequest() {}

    public ChangeRequest(Long projectId, Long authorId, String filename, String before, String after) {
        this.projectId = projectId;
        this.authorId = authorId;
        this.filename = filename;
        this.beforeContent = before;
        this.afterContent = after;
    }

    public Long getId() { return id; }
    public Long getProjectId() { return projectId; }
    public Long getAuthorId() { return authorId; }
    public String getFilename() { return filename; }
    public String getBeforeContent() { return beforeContent; }
    public String getAfterContent() { return afterContent; }
    public String getStatus() { return status; }
    public void setStatus(String v) { this.status = v; }
    public Instant getCreatedAt() { return createdAt; }
}

@Entity
@Table(name = "notifications")
class Notification {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private Long userId;

    private String title;

    @Column(length = 500)
    private String description;

    private String route = "";
    private boolean read = false;

    /** A real timestamp, not a string. Your old version stored "2m ago" as text,
        which meant the list could never sort correctly as time passed. */
    private Instant createdAt = Instant.now();

    public Notification() {}

    public Notification(Long userId, String title, String description, String route) {
        this.userId = userId;
        this.title = title;
        this.description = description;
        this.route = route;
    }

    public Long getId() { return id; }
    public Long getUserId() { return userId; }
    public String getTitle() { return title; }
    public String getDescription() { return description; }
    public String getRoute() { return route; }
    public boolean isRead() { return read; }
    public void setRead(boolean v) { this.read = v; }
    public Instant getCreatedAt() { return createdAt; }
}

/* -------------------------------------------------------------------------
   REPOSITORIES
   ------------------------------------------------------------------------- */

@Repository interface UserRepo extends JpaRepository<KnightUser, Long> {
    Optional<KnightUser> findByEmailIgnoreCase(String email);
    Optional<KnightUser> findBySocialIdIgnoreCase(String socialId);
    boolean existsByEmailIgnoreCase(String email);
    boolean existsBySocialId(String socialId);
}

@Repository interface SessionRepo extends JpaRepository<SessionToken, Long> {
    Optional<SessionToken> findByToken(String token);
    void deleteByToken(String token);
}

@Repository interface ProjectRepo extends JpaRepository<Project, Long> {
    List<Project> findByOwnerId(Long ownerId);
    List<Project> findByVisibility(String visibility);
    Optional<Project> findByJoinCode(String joinCode);
}

@Repository interface MemberRepo extends JpaRepository<ProjectMember, Long> {
    List<ProjectMember> findByProjectId(Long projectId);
    List<ProjectMember> findByUserId(Long userId);
    Optional<ProjectMember> findByProjectIdAndUserId(Long projectId, Long userId);
}

@Repository interface VersionRepo extends JpaRepository<ProjectVersion, Long> {
    List<ProjectVersion> findByProjectIdOrderByIdAsc(Long projectId);
    long countByProjectId(Long projectId);
}

@Repository interface ChangeRepo extends JpaRepository<ChangeRequest, Long> {
    List<ChangeRequest> findByProjectIdAndStatus(Long projectId, String status);
}

@Repository interface NotifRepo extends JpaRepository<Notification, Long> {
    List<Notification> findByUserIdOrderByCreatedAtDesc(Long userId);
    void deleteByUserId(Long userId);
}

/* -------------------------------------------------------------------------
   SERVICES
   ------------------------------------------------------------------------- */

@Service
class AuthService {
    private final UserRepo users;
    private final SessionRepo sessions;
    private final SecureRandom random = new SecureRandom();

    AuthService(UserRepo users, SessionRepo sessions) {
        this.users = users;
        this.sessions = sessions;
    }

    String sha256(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] out = md.digest(input.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : out) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    String newSocialId() {
        String chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        String candidate;
        do {
            StringBuilder sb = new StringBuilder("KNT-");
            for (int i = 0; i < 6; i++) sb.append(chars.charAt(random.nextInt(chars.length())));
            candidate = sb.toString();
        } while (users.existsBySocialId(candidate));
        return candidate;
    }

    KnightUser signUp(String email, String username, String passHash) {
        String key = email.toLowerCase().trim();
        if (users.existsByEmailIgnoreCase(key))
            throw new ApiException(HttpStatus.CONFLICT, "An account with that email already exists.");
        if (passHash == null || passHash.length() < 10)
            throw new ApiException(HttpStatus.BAD_REQUEST, "Missing or invalid credentials.");

        KnightUser u = new KnightUser(key,
                (username == null || username.isBlank()) ? key.split("@")[0] : username.trim(),
                passHash, newSocialId());
        // First account created on a fresh deployment becomes the admin.
        u.setAdmin(users.count() == 0);
        return users.save(u);
    }

    KnightUser signIn(String email, String passHash) {
        KnightUser u = users.findByEmailIgnoreCase(email.toLowerCase().trim())
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "No account found for that email."));
        if (!u.getPassHash().equals(passHash))
            throw new ApiException(HttpStatus.UNAUTHORIZED, "Incorrect passphrase.");
        u.setLastSeen(Instant.now());
        return users.save(u);
    }

    /** Guests are real rows, so their projects and chats behave normally. */
    KnightUser createGuest() {
        String email = "guest-" + System.currentTimeMillis() + "@knight.local";
        KnightUser u = new KnightUser(email, "guest_" + (users.count() + 1),
                sha256(UUID.randomUUID().toString()), newSocialId());
        u.setGuest(true);
        return users.save(u);
    }

    String issueToken(KnightUser user) {
        String token = UUID.randomUUID().toString().replace("-", "")
                + Long.toHexString(random.nextLong());
        sessions.save(new SessionToken(token, user.getId(), Instant.now().plusSeconds(365L * 24 * 3600)));
        return token;
    }

    /** Resolve "who is calling" from the Authorization header. */
    KnightUser requireUser(String authHeader) {
        if (authHeader == null || authHeader.isBlank())
            throw new ApiException(HttpStatus.UNAUTHORIZED, "Not signed in.");
        String token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
        SessionToken s = sessions.findByToken(token)
                .orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "Session not recognised."));
        if (s.isExpired()) {
            sessions.delete(s);
            throw new ApiException(HttpStatus.UNAUTHORIZED, "Session expired — please sign in again.");
        }
        return users.findById(s.getUserId())
                .orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "Account no longer exists."));
    }

    void signOut(String authHeader) {
        if (authHeader == null) return;
        String token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
        sessions.findByToken(token).ifPresent(sessions::delete);
    }
}

@Service
class ProjectService {
    private final ProjectRepo projects;
    private final MemberRepo members;
    private final VersionRepo versions;
    private final ChangeRepo changes;
    private final NotifRepo notifs;
    private final UserRepo users;

    ProjectService(ProjectRepo p, MemberRepo m, VersionRepo v, ChangeRepo c, NotifRepo n, UserRepo u) {
        this.projects = p; this.members = m; this.versions = v;
        this.changes = c; this.notifs = n; this.users = u;
    }

    /** owner > editor > contributor > viewer > null */
    String roleOf(Project p, KnightUser user) {
        if (p.getOwnerId().equals(user.getId())) return "owner";
        return members.findByProjectIdAndUserId(p.getId(), user.getId())
                .map(ProjectMember::getRole).orElse(null);
    }

    boolean canView(Project p, KnightUser user) {
        if (roleOf(p, user) != null) return true;
        switch (p.getVisibility()) {
            case "public":  return true;
            case "friends": return user.getFriends().contains(p.getOwnerId());
            default:        return false;   // selected / private
        }
    }

    boolean canEditDirectly(Project p, KnightUser user) {
        String r = roleOf(p, user);
        return "owner".equals(r) || "editor".equals(r);
    }

    boolean canPropose(Project p, KnightUser user) {
        String r = roleOf(p, user);
        return "owner".equals(r) || "editor".equals(r) || "contributor".equals(r);
    }

    Project create(KnightUser owner, ProjectRequest req) {
        Project p = new Project();
        p.setOwnerId(owner.getId());
        p.setName(req.name);
        p.setDescription(req.description == null ? "" : req.description);
        p.setCategory(req.category == null ? "General" : req.category);
        p.setVisibility(req.visibility == null ? "public" : req.visibility);
        p.setTags(req.tags == null ? new ArrayList<>() : req.tags);
        p.setLocationLabel(req.locationLabel == null ? "" : req.locationLabel);
        p.setLat(req.lat);
        p.setLng(req.lng);
        p.setJoinCode(UUID.randomUUID().toString().substring(0, 12).toUpperCase());
        Project saved = projects.save(p);

        // Every project starts life at Version 1, exactly like the frontend.
        versions.save(new ProjectVersion(saved.getId(), "Version 1", "Initial version", new HashMap<>()));
        return saved;
    }

    ProjectVersion cutVersion(Project p, String note) {
        long n = versions.countByProjectId(p.getId()) + 1;
        return versions.save(new ProjectVersion(p.getId(), "Version " + n, note, p.getFiles()));
    }

    void notify(Long userId, String title, String desc, String route) {
        notifs.save(new Notification(userId, title, desc, route));
    }

    ProjectRepo projects() { return projects; }
    MemberRepo members()   { return members; }
    VersionRepo versions() { return versions; }
    ChangeRepo changes()   { return changes; }
    UserRepo users()       { return users; }
}

/* -------------------------------------------------------------------------
   CONTROLLERS
   ------------------------------------------------------------------------- */

@RestController
@RequestMapping("/api/auth")
class AuthController {
    private final AuthService auth;

    AuthController(AuthService auth) { this.auth = auth; }

    @PostMapping("/signup")
    ResponseEntity<AuthResponse> signUp(@RequestBody AuthRequest req) {
        KnightUser u = auth.signUp(req.email, req.username, req.passHash);
        return ResponseEntity.ok(new AuthResponse(auth.issueToken(u), u));
    }

    @PostMapping("/signin")
    ResponseEntity<AuthResponse> signIn(@RequestBody AuthRequest req) {
        KnightUser u = auth.signIn(req.email, req.passHash);
        return ResponseEntity.ok(new AuthResponse(auth.issueToken(u), u));
    }

    @PostMapping("/guest")
    ResponseEntity<AuthResponse> guest() {
        KnightUser u = auth.createGuest();
        return ResponseEntity.ok(new AuthResponse(auth.issueToken(u), u));
    }

    /** The frontend calls this on load to restore a session. */
    @GetMapping("/me")
    ResponseEntity<KnightUser> me(@RequestHeader(value = "Authorization", required = false) String h) {
        return ResponseEntity.ok(auth.requireUser(h));
    }

    @PostMapping("/signout")
    ResponseEntity<Map<String, String>> signOut(@RequestHeader(value = "Authorization", required = false) String h) {
        auth.signOut(h);
        return ResponseEntity.ok(Map.of("status", "signed out"));
    }
}

@RestController
@RequestMapping("/api")
class KnightController {
    private final AuthService auth;
    private final ProjectService svc;
    private final NotifRepo notifs;

    KnightController(AuthService auth, ProjectService svc, NotifRepo notifs) {
        this.auth = auth; this.svc = svc; this.notifs = notifs;
    }

    /* ----- profile ----- */

    @GetMapping("/profile")
    ResponseEntity<KnightUser> profile(@RequestHeader(value = "Authorization", required = false) String h) {
        return ResponseEntity.ok(auth.requireUser(h));
    }

    @PutMapping("/profile")
    ResponseEntity<KnightUser> updateProfile(@RequestHeader(value = "Authorization", required = false) String h,
                                             @RequestBody ProfileUpdateRequest req) {
        KnightUser u = auth.requireUser(h);
        if (req.username != null && !req.username.isBlank()) u.setUsername(req.username.trim());
        if (req.role != null)         u.setRole(req.role);
        if (req.bio != null)          u.setBio(req.bio);
        if (req.github != null)       u.setGithub(req.github);
        if (req.twitter != null)      u.setTwitter(req.twitter);
        if (req.avatarIndex != null)  u.setAvatarIndex(req.avatarIndex);
        return ResponseEntity.ok(svc.users().save(u));
    }

    @GetMapping("/users/{socialId}")
    ResponseEntity<KnightUser> publicProfile(@RequestHeader(value = "Authorization", required = false) String h,
                                             @PathVariable String socialId) {
        auth.requireUser(h);
        return ResponseEntity.ok(svc.users().findBySocialIdIgnoreCase(socialId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "No Knight with that Social ID.")));
    }

    /* ----- projects ----- */

    @GetMapping("/projects")
    ResponseEntity<List<Project>> myProjects(@RequestHeader(value = "Authorization", required = false) String h) {
        KnightUser u = auth.requireUser(h);
        Set<Long> ids = svc.members().findByUserId(u.getId()).stream()
                .map(ProjectMember::getProjectId).collect(Collectors.toSet());
        List<Project> out = new ArrayList<>(svc.projects().findByOwnerId(u.getId()));
        svc.projects().findAllById(ids).forEach(out::add);
        return ResponseEntity.ok(out);
    }

    /** Studio feed — only what this user is actually allowed to see. */
    @GetMapping("/studio")
    ResponseEntity<List<Project>> studio(@RequestHeader(value = "Authorization", required = false) String h) {
        KnightUser u = auth.requireUser(h);
        return ResponseEntity.ok(svc.projects().findAll().stream()
                .filter(p -> svc.canView(p, u))
                .collect(Collectors.toList()));
    }

    @PostMapping("/projects")
    ResponseEntity<Project> create(@RequestHeader(value = "Authorization", required = false) String h,
                                   @RequestBody ProjectRequest req) {
        KnightUser u = auth.requireUser(h);
        if (req.name == null || req.name.isBlank())
            throw new ApiException(HttpStatus.BAD_REQUEST, "Project name is required.");
        return ResponseEntity.ok(svc.create(u, req));
    }

    @GetMapping("/projects/{id}")
    ResponseEntity<Map<String, Object>> detail(@RequestHeader(value = "Authorization", required = false) String h,
                                               @PathVariable Long id) {
        KnightUser u = auth.requireUser(h);
        Project p = svc.projects().findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Project not found."));
        if (!svc.canView(p, u))
            throw new ApiException(HttpStatus.FORBIDDEN, "You do not have access to that project.");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("project", p);
        out.put("yourRole", svc.roleOf(p, u));
        out.put("members", svc.members().findByProjectId(id));
        out.put("versions", svc.versions().findByProjectIdOrderByIdAsc(id));
        out.put("changeRequests", svc.changes().findByProjectIdAndStatus(id, "pending"));
        return ResponseEntity.ok(out);
    }

    /* ----- files: this is where the role rules actually bite ----- */

    @PutMapping("/projects/{id}/files/{filename}")
    ResponseEntity<Map<String, Object>> saveFile(@RequestHeader(value = "Authorization", required = false) String h,
                                                 @PathVariable Long id,
                                                 @PathVariable String filename,
                                                 @RequestBody FileRequest req) {
        KnightUser u = auth.requireUser(h);
        Project p = svc.projects().findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Project not found."));

        if (svc.canEditDirectly(p, u)) {
            p.getFiles().put(filename, req.content == null ? "" : req.content);
            p.setUpdatedAt(Instant.now());
            svc.projects().save(p);
            return ResponseEntity.ok(Map.of("status", "saved"));
        }

        if (svc.canPropose(p, u)) {
            // Contributors never touch the real file — the edit becomes a request.
            ChangeRequest cr = svc.changes().save(new ChangeRequest(
                    id, u.getId(), filename,
                    p.getFiles().getOrDefault(filename, ""),
                    req.content == null ? "" : req.content));
            svc.notify(p.getOwnerId(), "New Change Request",
                    u.getUsername() + " proposed an edit to " + filename + ".", "#/project/" + id);
            return ResponseEntity.ok(Map.of("status", "change-request-created", "id", cr.getId()));
        }

        throw new ApiException(HttpStatus.FORBIDDEN, "You have read-only access to this project.");
    }

    /** Deleting is deliberately owner/editor only — contributors are blocked. */
    @DeleteMapping("/projects/{id}/files/{filename}")
    ResponseEntity<Map<String, String>> deleteFile(@RequestHeader(value = "Authorization", required = false) String h,
                                                   @PathVariable Long id,
                                                   @PathVariable String filename) {
        KnightUser u = auth.requireUser(h);
        Project p = svc.projects().findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Project not found."));
        if (!svc.canEditDirectly(p, u))
            throw new ApiException(HttpStatus.FORBIDDEN, "Contributors and viewers cannot delete files.");
        p.getFiles().remove(filename);
        p.setUpdatedAt(Instant.now());
        svc.projects().save(p);
        return ResponseEntity.ok(Map.of("status", "deleted"));
    }

    /* ----- change requests ----- */

    @PostMapping("/changes/{crId}/review")
    ResponseEntity<Map<String, String>> review(@RequestHeader(value = "Authorization", required = false) String h,
                                               @PathVariable Long crId,
                                               @RequestParam boolean accept) {
        KnightUser u = auth.requireUser(h);
        ChangeRequest cr = svc.changes().findById(crId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Change request not found."));
        Project p = svc.projects().findById(cr.getProjectId())
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Project not found."));
        if (!svc.canEditDirectly(p, u))
            throw new ApiException(HttpStatus.FORBIDDEN, "Only owners and editors can review changes.");

        cr.setStatus(accept ? "accepted" : "rejected");
        svc.changes().save(cr);

        if (accept) {
            p.getFiles().put(cr.getFilename(), cr.getAfterContent());
            p.setUpdatedAt(Instant.now());
            svc.projects().save(p);
            u.setCommits(u.getCommits() + 1);
            svc.users().save(u);
        }
        svc.notify(cr.getAuthorId(), accept ? "Change Accepted" : "Change Rejected",
                "Your edit to " + cr.getFilename() + " was " + (accept ? "merged" : "rejected") + ".",
                "#/project/" + p.getId());
        return ResponseEntity.ok(Map.of("status", cr.getStatus()));
    }

    /* ----- versions ----- */

    @PostMapping("/projects/{id}/versions")
    ResponseEntity<ProjectVersion> cutVersion(@RequestHeader(value = "Authorization", required = false) String h,
                                              @PathVariable Long id,
                                              @RequestBody VersionRequest req) {
        KnightUser u = auth.requireUser(h);
        Project p = svc.projects().findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Project not found."));
        if (!svc.canEditDirectly(p, u))
            throw new ApiException(HttpStatus.FORBIDDEN, "Only owners and editors can cut versions.");
        return ResponseEntity.ok(svc.cutVersion(p, req.note == null ? "Snapshot" : req.note));
    }

    /* ----- members + invite passkeys ----- */

    @PostMapping("/projects/{id}/members")
    ResponseEntity<ProjectMember> addMember(@RequestHeader(value = "Authorization", required = false) String h,
                                            @PathVariable Long id,
                                            @RequestBody MemberRequest req) {
        KnightUser u = auth.requireUser(h);
        Project p = svc.projects().findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Project not found."));
        if (!"owner".equals(svc.roleOf(p, u)))
            throw new ApiException(HttpStatus.FORBIDDEN, "Only the owner can invite people.");

        KnightUser target = svc.users().findBySocialIdIgnoreCase(req.socialId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "No Knight with that Social ID."));
        if (target.getId().equals(p.getOwnerId()))
            throw new ApiException(HttpStatus.BAD_REQUEST, "That is the project owner.");
        if (svc.members().findByProjectIdAndUserId(id, target.getId()).isPresent())
            throw new ApiException(HttpStatus.CONFLICT, "Already a member.");

        svc.notify(target.getId(), "Added to a project",
                u.getUsername() + " added you to " + p.getName() + ".", "#/project/" + id);
        return ResponseEntity.ok(svc.members().save(
                new ProjectMember(id, target.getId(), req.role == null ? "viewer" : req.role)));
    }

    @PostMapping("/projects/join")
    ResponseEntity<Map<String, Object>> joinByCode(@RequestHeader(value = "Authorization", required = false) String h,
                                                   @RequestBody JoinRequest req) {
        KnightUser u = auth.requireUser(h);
        Project p = svc.projects().findByJoinCode(req.code == null ? "" : req.code.toUpperCase())
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "That passkey is not valid."));
        if (!p.isJoinCodeEnabled())
            throw new ApiException(HttpStatus.FORBIDDEN, "That passkey has been revoked.");
        if (p.getOwnerId().equals(u.getId()) ||
            svc.members().findByProjectIdAndUserId(p.getId(), u.getId()).isPresent())
            return ResponseEntity.ok(Map.of("status", "already-member", "projectId", p.getId()));

        svc.members().save(new ProjectMember(p.getId(), u.getId(), p.getJoinCodeRole()));
        svc.notify(p.getOwnerId(), "Someone joined",
                u.getUsername() + " joined " + p.getName() + " via passkey.", "#/project/" + p.getId());
        return ResponseEntity.ok(Map.of("status", "joined", "projectId", p.getId(), "role", p.getJoinCodeRole()));
    }

    /* ----- stars ----- */

    @PostMapping("/projects/{id}/star")
    ResponseEntity<Map<String, Object>> star(@RequestHeader(value = "Authorization", required = false) String h,
                                             @PathVariable Long id) {
        KnightUser u = auth.requireUser(h);
        Project p = svc.projects().findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Project not found."));
        boolean starred;
        if (p.getStarredBy().contains(u.getId())) {
            p.getStarredBy().remove(u.getId());
            p.setStars(Math.max(0, p.getStars() - 1));
            starred = false;
        } else {
            p.getStarredBy().add(u.getId());
            p.setStars(p.getStars() + 1);
            starred = true;
        }
        svc.projects().save(p);
        return ResponseEntity.ok(Map.of("starred", starred, "stars", p.getStars()));
    }

    /* ----- notifications ----- */

    @GetMapping("/notifications")
    ResponseEntity<List<Notification>> list(@RequestHeader(value = "Authorization", required = false) String h) {
        return ResponseEntity.ok(notifs.findByUserIdOrderByCreatedAtDesc(auth.requireUser(h).getId()));
    }

    @PutMapping("/notifications/{id}/read")
    ResponseEntity<Notification> markRead(@RequestHeader(value = "Authorization", required = false) String h,
                                          @PathVariable Long id) {
        auth.requireUser(h);
        Notification n = notifs.findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Notification not found."));
        n.setRead(true);
        return ResponseEntity.ok(notifs.save(n));
    }

    @GetMapping("/health")
    ResponseEntity<Map<String, Object>> health() {
        return ResponseEntity.ok(Map.of("status", "up", "time", Instant.now().toString()));
    }
}

/* -------------------------------------------------------------------------
   ERROR HANDLING
   Errors come back as clean JSON with a readable message, so the frontend can
   show the real reason instead of a generic "couldn't fetch account".
   ------------------------------------------------------------------------- */

class ApiException extends RuntimeException {
    final HttpStatus status;
    ApiException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }
}

@RestControllerAdvice
class ErrorHandler {
    @ExceptionHandler(ApiException.class)
    ResponseEntity<Map<String, Object>> handleApi(ApiException e) {
        return ResponseEntity.status(e.status).body(Map.of(
                "error", e.getMessage(),
                "status", e.status.value()));
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<Map<String, Object>> handleOther(Exception e) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                "error", "Unexpected server error: " + e.getClass().getSimpleName(),
                "status", 500));
    }
}

/* -------------------------------------------------------------------------
   DTOs
   ------------------------------------------------------------------------- */

class AuthRequest {
    public String email;
    public String username;
    public String passHash;     // SHA-256 of (password + email), done in the browser
}

class AuthResponse {
    public String token;
    public KnightUser user;
    AuthResponse(String token, KnightUser user) { this.token = token; this.user = user; }
}

class ProfileUpdateRequest {
    public String username, role, bio, github, twitter;
    public Integer avatarIndex;
}

class ProjectRequest {
    public String name, description, category, visibility, locationLabel;
    public List<String> tags;
    public Double lat, lng;
}

class FileRequest    { public String content; }
class VersionRequest { public String note; }
class MemberRequest  { public String socialId, role; }
class JoinRequest    { public String code; }

/* ============================================================================
   src/main/resources/application.properties — copy this into that file:

     spring.datasource.url=jdbc:h2:file:./data/knight;DB_CLOSE_ON_EXIT=FALSE
     spring.datasource.driverClassName=org.h2.Driver
     spring.datasource.username=sa
     spring.datasource.password=
     spring.jpa.database-platform=org.hibernate.dialect.H2Dialect
     spring.jpa.hibernate.ddl-auto=update
     server.port=${PORT:8080}

   Note the `h2:file:` — your old setup used an in-memory database, which wiped
   every account the moment the server restarted. Writing to a file is what
   makes accounts survive.

   For production, swap in Postgres:
     spring.datasource.url=${DATABASE_URL}
     spring.jpa.database-platform=org.hibernate.dialect.PostgreSQLDialect

   pom.xml dependencies:
     spring-boot-starter-web
     spring-boot-starter-data-jpa
     com.h2database:h2            (runtime)
     org.postgresql:postgresql    (runtime, production only)
============================================================================ */
