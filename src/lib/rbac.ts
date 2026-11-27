import { User, Profile } from "../types";

export class RBAC {
  /**
   * 检查用户是否为管理员
   */
  static isAdmin(user: User): boolean {
    return user.role === 'admin';
  }

  /**
   * 检查用户是否有权访问特定 Profile
   */
  static canAccessProfile(user: User, profile: Profile): boolean {
    // 严格限制所有权，即便是 admin 也不应直接查看其他用户的业务配置/日志
    return profile.owner_id === user.id;
  }
}
